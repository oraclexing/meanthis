import type {
  CaptureSessionFile,
  CaptureSessionFileV1,
  CaptureSessionFileV2,
  CaptureSessionFileV3,
  CaptureSessionAnnotationLifecycleStateV3,
} from "@meanthis/hub-core";
import { isCaptureSessionAnnotationId } from "@meanthis/hub-core";
import type { OriginCaptureRecord } from "./capture-store";
import {
  EXTENSION_SESSION_MAX_ITEMS,
  serializeCaptureSessionFile,
  toSessionFileSourceRecord,
} from "./session-file";

export interface CaptureReceipt {
  operationId: string;
  itemId: string;
  annotationId?: string | null;
}

export interface CaptureSessionMetaV1 {
  epoch: string;
  clearPending: boolean;
  activeClearOperationId: string | null;
  lastCompletedClearOperationId: string | null;
  receipts: CaptureReceipt[];
}

export interface CaptureToken {
  origin: string;
  epoch: string;
  operationId: string;
  replacement: null | {
    itemId: string;
    annotationId?: string | null;
    createdAt: string;
    capturedAt: string;
  };
}

export type SessionStateErrorCode =
  | "CLEAR_IN_PROGRESS"
  | "INVALID_SESSION_FILE"
  | "ITEM_NOT_FOUND"
  | "SESSION_FULL"
  | "SESSION_TOO_LARGE"
  | "STALE_CAPTURE_OPERATION"
  | "STALE_SESSION";

export interface SessionState {
  file: CaptureSessionFile | null;
  meta: CaptureSessionMetaV1;
}

type SessionStateResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: SessionStateErrorCode;
      error: string;
      issues?: Array<{ path: string; message: string }>;
    };

export function createSessionMeta(epoch: string): CaptureSessionMetaV1 {
  return {
    epoch,
    clearPending: false,
    activeClearOperationId: null,
    lastCompletedClearOperationId: null,
    receipts: [],
  };
}

export function beginCapture(
  state: SessionState,
  origin: string,
  operationId: string,
  replaceItemId: string | null = null,
): SessionStateResult<CaptureToken> {
  const normalized = normalizeState(state);
  if (!normalized.ok) return normalized;
  if (normalized.value.meta.clearPending) {
    return failure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
  }
  if (normalized.value.file && normalized.value.file.session.origin !== origin) {
    return failure("STALE_SESSION", "Capture origin does not match the active session.");
  }
  const replacementItem = replaceItemId === null
    ? null
    : normalized.value.file?.session.attachments.find((item) => item.id === replaceItemId) ?? null;
  if (replaceItemId !== null && replacementItem === null) {
    return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
  }
  return {
    ok: true,
    value: {
      origin,
      epoch: normalized.value.meta.epoch,
      operationId,
      replacement: replacementItem === null
        ? null
        : {
            itemId: replacementItem.id,
            annotationId: sessionItemAnnotationId(replacementItem),
            createdAt: replacementItem.createdAt,
            capturedAt: replacementItem.sourceRecord.capturedAt,
          },
    },
  };
}

export function commitCapture(
  state: SessionState,
  token: CaptureToken,
  record: OriginCaptureRecord,
  committedAt: string,
  createAnnotationId: () => string = defaultCreateAnnotationId,
): SessionStateResult<SessionState> {
  const normalized = normalizeState(state);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  const captureToken = structuredClone(token);
  const captureRecord = structuredClone(record);

  if (next.meta.clearPending) {
    return failure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
  }
  if (captureToken.epoch !== next.meta.epoch) {
    return failure("STALE_CAPTURE_OPERATION", "Capture operation belongs to a stale epoch.");
  }
  if (captureToken.origin !== captureRecord.origin) {
    return failure("STALE_CAPTURE_OPERATION", "Capture operation origin does not match the record.");
  }
  if (next.file && captureToken.origin !== next.file.session.origin) {
    return failure("STALE_CAPTURE_OPERATION", "Capture operation origin does not match the session.");
  }
  const existingReceipt = next.meta.receipts.find(
    (receipt) => receipt.operationId === captureToken.operationId,
  );
  if (existingReceipt) {
    const receiptItem = next.file?.session.attachments.find(
      (item) => item.id === existingReceipt.itemId,
    );
    if (!receiptItem) {
      return failure("ITEM_NOT_FOUND", "Receipt item is no longer present in the session.");
    }
    if (!receiptMatchesSessionItem(existingReceipt, receiptItem)) {
      return failure(
        "STALE_CAPTURE_OPERATION",
        "Capture receipt belongs to a replaced annotation.",
      );
    }
    next.meta.receipts = appendReceipt(
      next.meta.receipts,
      captureToken.operationId,
      existingReceipt.itemId,
      existingReceipt.annotationId,
    );
    return { ok: true, value: next };
  }

  const sourceRecord = toSessionFileSourceRecord(captureRecord);
  const explicitReplacementBeforeUpgrade = captureToken.replacement === null
    ? null
    : next.file?.session.attachments.find(
      (item) => item.id === captureToken.replacement?.itemId,
    ) ?? null;
  if (captureToken.replacement !== null && explicitReplacementBeforeUpgrade === null) {
    return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
  }
  if (
    captureToken.replacement !== null &&
    explicitReplacementBeforeUpgrade !== null &&
    (
      explicitReplacementBeforeUpgrade.createdAt !== captureToken.replacement.createdAt ||
      explicitReplacementBeforeUpgrade.sourceRecord.capturedAt !==
        captureToken.replacement.capturedAt ||
      sessionItemAnnotationId(explicitReplacementBeforeUpgrade) !==
        (captureToken.replacement.annotationId ?? null)
    )
  ) {
    return failure(
      "STALE_CAPTURE_OPERATION",
      "Capture replacement belongs to a stale item version.",
    );
  }

  if (
    captureToken.replacement === null &&
    next.file &&
    next.file.session.attachments.length >= EXTENSION_SESSION_MAX_ITEMS
  ) {
    return failure("SESSION_FULL", "Capture session already contains 26 items.");
  }

  let appendedAt = committedAt;
  if (captureToken.replacement === null && next.file) {
    const advancedSessionTimestamp = advanceTimestamp(
      next.file.session.updatedAt,
      committedAt,
    );
    if (!advancedSessionTimestamp.ok) return advancedSessionTimestamp;
    appendedAt = advancedSessionTimestamp.value;
  }

  if (next.file && next.file.schemaVersion !== "0.3.0") {
    const sourceVersion = next.file.schemaVersion;
    const upgraded = upgradeFileToV3(
      next.file,
      createAnnotationId,
    );
    if (!upgraded.ok) return upgraded;
    if (sourceVersion === "0.1.0") {
      next.meta.receipts = bindLegacyV1Receipts(next.meta.receipts, upgraded.value);
    }
    next.file = upgraded.value;
  }

  const recapturedItem = captureToken.replacement === null
    ? null
    : next.file?.session.attachments.find(
      (item) => item.id === captureToken.replacement?.itemId,
    ) ?? null;
  if (next.file?.schemaVersion === "0.3.0" && recapturedItem) {
    const currentFile = next.file as CaptureSessionFileV3;
    const currentItem = recapturedItem as CaptureSessionFileV3["session"]["attachments"][number];
    const refreshedSourceRecord = {
      ...sourceRecord,
      attachment: {
        ...sourceRecord.attachment,
        id: currentItem.sourceRecord.attachment.id,
      },
      intent: currentItem.sourceRecord.intent,
    };
    const advancedMutationTimestamp = advanceTimestamp(
      currentFile.session.updatedAt,
      committedAt,
    );
    if (!advancedMutationTimestamp.ok) return advancedMutationTimestamp;
    const itemUpdatedAt = advancedMutationTimestamp.value;
    const file: CaptureSessionFileV3 = {
      ...currentFile,
      session: {
        ...currentFile.session,
        updatedAt: itemUpdatedAt,
        attachments: currentFile.session.attachments.map((item) => (
          item.id === currentItem.id
            ? {
                ...item,
                updatedAt: itemUpdatedAt,
                sourceRecord: refreshedSourceRecord,
              }
            : item
        )),
      },
    };
    const serialized = serializeCaptureSessionFile(file);
    if (!serialized.ok) return serialized;
    next.file = serialized.value.file;
    next.meta.receipts = appendReceipt(
      next.meta.receipts,
      captureToken.operationId,
      currentItem.id,
      currentItem.annotationId,
    );
    return { ok: true, value: next };
  }

  const itemId = nextAttachmentId(
    sourceRecord.attachment.id,
    next.file?.session.attachments.map((item) => item.id) ?? [],
  );
  const currentFile = next.file?.schemaVersion === "0.3.0"
    ? next.file as CaptureSessionFileV3
    : null;
  const annotationId = createUniqueAnnotationId(
    currentFile?.session.attachments.map((item) => item.annotationId) ?? [],
    createAnnotationId,
  );
  if (!annotationId.ok) return annotationId;
  const item = {
    id: itemId,
    annotationId: annotationId.value,
    createdAt: appendedAt,
    updatedAt: appendedAt,
    annotationLifecycle: {
      state: "open" as const,
      resolvedAt: null,
    },
    labels: [nextLabel(next.file?.session.attachments.flatMap((entry) => entry.labels) ?? [])],
    sourceRecord,
  };
  const file: CaptureSessionFileV3 =
    currentFile === null
      ? {
          schemaVersion: "0.3.0",
          kind: "ui-attach.capture-session",
          session: {
            id: "session-1",
            title: null,
            createdAt: committedAt,
            updatedAt: committedAt,
            origin: captureRecord.origin,
            attachments: [item],
          },
        }
      : {
          ...currentFile,
          schemaVersion: "0.3.0",
          session: {
            ...currentFile.session,
            updatedAt: appendedAt,
            attachments: [...currentFile.session.attachments, item],
          },
        };

  const serialized = serializeCaptureSessionFile(file);
  if (!serialized.ok) {
    return serialized;
  }
  next.file = serialized.value.file;
  next.meta.receipts = appendReceipt(
    next.meta.receipts,
    captureToken.operationId,
    itemId,
    annotationId.value,
  );
  return { ok: true, value: next };
}

export function updateSessionIntent(
  state: SessionState,
  epoch: string,
  itemId: string,
  intent: string,
  updatedAt: string,
  createAnnotationId: () => string = defaultCreateAnnotationId,
): SessionStateResult<SessionState> {
  const normalized = normalizeMutableSession(state, epoch);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  const existingItem = next.file.session.attachments.find((entry) => entry.id === itemId);
  if (!existingItem) {
    return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
  }
  if (existingItem.sourceRecord.intent === intent) {
    next.meta.receipts = trimReceipts(next.meta.receipts);
    return serializeState(next);
  }
  if (next.file.schemaVersion !== "0.3.0") {
    const sourceVersion = next.file.schemaVersion;
    const upgraded = upgradeFileToV3(
      next.file,
      createAnnotationId,
    );
    if (!upgraded.ok) return upgraded;
    if (sourceVersion === "0.1.0") {
      next.meta.receipts = bindLegacyV1Receipts(next.meta.receipts, upgraded.value);
    }
    next.file = upgraded.value;
  }
  const currentFile = next.file as CaptureSessionFileV3;
  const item = currentFile.session.attachments.find((entry) => entry.id === itemId);
  if (!item) return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
  const advancedMutationTimestamp = advanceTimestamp(currentFile.session.updatedAt, updatedAt);
  if (!advancedMutationTimestamp.ok) return advancedMutationTimestamp;
  item.sourceRecord.intent = intent;
  item.updatedAt = advancedMutationTimestamp.value;
  currentFile.session.updatedAt = advancedMutationTimestamp.value;
  next.file = currentFile;
  next.meta.receipts = trimReceipts(next.meta.receipts);
  return serializeState(next);
}

export function updateSessionAnnotationLifecycle(
  state: SessionState,
  epoch: string,
  itemId: string,
  annotationId: string,
  expectedState: CaptureSessionAnnotationLifecycleStateV3,
  nextState: CaptureSessionAnnotationLifecycleStateV3,
  updatedAt: string,
): SessionStateResult<SessionState> {
  const normalized = normalizeMutableSession(state, epoch);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  if (
    (expectedState !== "open" && expectedState !== "resolved") ||
    (nextState !== "open" && nextState !== "resolved") ||
    expectedState === nextState
  ) {
    return failure("STALE_SESSION", "Annotation lifecycle transition is stale or invalid.");
  }
  if (next.file.schemaVersion === "0.1.0") {
    return failure("STALE_SESSION", "Annotation identity is unavailable for this session item.");
  }
  let currentState: CaptureSessionAnnotationLifecycleStateV3;
  if (next.file.schemaVersion === "0.3.0") {
    const existingItem = next.file.session.attachments.find((entry) => entry.id === itemId);
    if (!existingItem) {
      return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
    }
    if (existingItem.annotationId !== annotationId) {
      return failure("STALE_SESSION", "Annotation lifecycle request belongs to a stale identity.");
    }
    currentState = existingItem.annotationLifecycle.state;
  } else {
    const existingItem = next.file.session.attachments.find((entry) => entry.id === itemId);
    if (!existingItem) {
      return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
    }
    if (existingItem.annotationId !== annotationId) {
      return failure("STALE_SESSION", "Annotation lifecycle request belongs to a stale identity.");
    }
    currentState = "open";
  }
  if (currentState !== expectedState) {
    return failure("STALE_SESSION", "Annotation lifecycle request belongs to a stale state.");
  }
  if (next.file.schemaVersion === "0.2.0") {
    const upgraded = upgradeFileToV3(next.file, () => {
      throw new Error("V2 lifecycle migration must preserve existing annotation identities.");
    });
    if (!upgraded.ok) return upgraded;
    next.file = upgraded.value;
  }
  const currentFile = next.file as CaptureSessionFileV3;
  const item = currentFile.session.attachments.find((entry) => entry.id === itemId);
  if (!item || item.annotationId !== annotationId) {
    return failure("STALE_SESSION", "Annotation lifecycle request belongs to a stale identity.");
  }
  const advancedMutationTimestamp = advanceTimestamp(currentFile.session.updatedAt, updatedAt);
  if (!advancedMutationTimestamp.ok) return advancedMutationTimestamp;
  item.annotationLifecycle = nextState === "resolved"
    ? { state: "resolved", resolvedAt: advancedMutationTimestamp.value }
    : { state: "open", resolvedAt: null };
  item.updatedAt = advancedMutationTimestamp.value;
  currentFile.session.updatedAt = advancedMutationTimestamp.value;
  next.file = currentFile;
  next.meta.receipts = trimReceipts(next.meta.receipts);
  return serializeState(next);
}

export function removeSessionItem(
  state: SessionState,
  epoch: string,
  itemId: string,
  updatedAt: string,
): SessionStateResult<SessionState> {
  const normalized = normalizeMutableSession(state, epoch);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  const ownsItem = next.file.session.attachments.some((entry) => entry.id === itemId);
  if (!ownsItem) return serializeState(next);
  const advancedSessionTimestamp = advanceTimestamp(next.file.session.updatedAt, updatedAt);
  if (!advancedSessionTimestamp.ok) return advancedSessionTimestamp;
  next.file.session.attachments = next.file.session.attachments.filter(
    (entry) => entry.id !== itemId,
  );
  if (next.file.session.attachments.length === 0) {
    next.file.session.title = null;
  }
  next.file.session.updatedAt = advancedSessionTimestamp.value;
  next.meta.receipts = trimReceipts(next.meta.receipts);
  return serializeState(next);
}

export function startClearSession(
  state: SessionState,
  epoch: string,
  operationId: string,
  nextEpoch: string,
): SessionStateResult<SessionState> {
  const normalized = normalizeState(state);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  if (next.meta.clearPending) {
    if (next.meta.activeClearOperationId === operationId) {
      return { ok: true, value: next };
    }
    return failure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
  }
  if (next.meta.lastCompletedClearOperationId === operationId) {
    return { ok: true, value: next };
  }
  if (next.meta.epoch !== epoch) {
    return failure("STALE_SESSION", "Clear request belongs to a stale epoch.");
  }
  next.meta = {
    epoch: nextEpoch,
    clearPending: true,
    activeClearOperationId: operationId,
    lastCompletedClearOperationId: next.meta.lastCompletedClearOperationId,
    receipts: [],
  };
  return { ok: true, value: next };
}

export function completeClearSession(
  state: SessionState,
  epoch: string,
  operationId: string,
): SessionStateResult<SessionState> {
  const normalized = normalizeState(state);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  if (next.meta.clearPending) {
    if (next.meta.activeClearOperationId !== operationId) {
      return failure("CLEAR_IN_PROGRESS", "A different session clear is already in progress.");
    }
    if (next.meta.epoch !== epoch) {
      return failure("STALE_SESSION", "Clear completion belongs to a stale epoch.");
    }
    next.file = null;
    next.meta = {
      epoch: next.meta.epoch,
      clearPending: false,
      activeClearOperationId: null,
      lastCompletedClearOperationId: operationId,
      receipts: [],
    };
    return { ok: true, value: next };
  }
  if (next.meta.lastCompletedClearOperationId === operationId) {
    return { ok: true, value: next };
  }
  return failure("STALE_SESSION", "Clear request does not match the active session.");
}

function normalizeMutableSession(
  state: SessionState,
  epoch: string,
): SessionStateResult<SessionState & { file: CaptureSessionFile }> {
  const normalized = normalizeState(state);
  if (!normalized.ok) return normalized;
  if (normalized.value.meta.clearPending) {
    return failure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
  }
  if (normalized.value.meta.epoch !== epoch) {
    return failure("STALE_SESSION", "Session mutation belongs to a stale epoch.");
  }
  if (!normalized.value.file) {
    return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
  }
  return { ok: true, value: normalized.value as SessionState & { file: CaptureSessionFile } };
}

function normalizeState(state: SessionState): SessionStateResult<SessionState> {
  const next = structuredClone(state);
  if (!Array.isArray(next.meta.receipts) || !next.meta.receipts.every(isCaptureReceipt)) {
    return failure("INVALID_SESSION_FILE", "Stored capture receipts are invalid.");
  }
  next.meta.receipts = trimReceipts(next.meta.receipts);
  if (!next.file) {
    return { ok: true, value: next };
  }
  return serializeState(next);
}

function serializeState(state: SessionState): SessionStateResult<SessionState> {
  if (!state.file) {
    return { ok: true, value: state };
  }
  const serialized = serializeCaptureSessionFile(state.file);
  if (!serialized.ok) {
    return serialized;
  }
  return { ok: true, value: { ...state, file: serialized.value.file } };
}

function appendReceipt(
  receipts: CaptureReceipt[],
  operationId: string,
  itemId: string,
  annotationId?: string | null,
): CaptureReceipt[] {
  const receipt: CaptureReceipt = {
    operationId,
    itemId,
    ...(annotationId === undefined ? {} : { annotationId }),
  };
  return [
    ...receipts.filter((receipt) => receipt.operationId !== operationId),
    receipt,
  ].slice(-64);
}

function trimReceipts(receipts: CaptureReceipt[]): CaptureReceipt[] {
  return receipts.slice(-64);
}

function isCaptureReceipt(value: unknown): value is CaptureReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<PropertyKey, unknown>;
  const hasAnnotationId = Object.hasOwn(record, "annotationId");
  const allowedKeys = new Set([
    "operationId",
    "itemId",
    ...(hasAnnotationId ? ["annotationId"] : []),
  ]);
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.length !== allowedKeys.size ||
    ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
    typeof record.operationId !== "string" ||
    typeof record.itemId !== "string"
  ) {
    return false;
  }
  return !hasAnnotationId ||
    record.annotationId === null ||
    isCaptureSessionAnnotationId(record.annotationId);
}

function bindLegacyV1Receipts(
  receipts: CaptureReceipt[],
  upgradedFile: CaptureSessionFileV3,
): CaptureReceipt[] {
  const annotationIdsByItemId = new Map(
    upgradedFile.session.attachments.map((item) => [item.id, item.annotationId] as const),
  );
  return receipts.map((receipt) => {
    const annotationId = annotationIdsByItemId.get(receipt.itemId);
    if (
      annotationId === undefined ||
      (Object.hasOwn(receipt, "annotationId") && receipt.annotationId !== null)
    ) {
      return receipt;
    }
    return { ...receipt, annotationId };
  });
}

function nextAttachmentId(baseId: string, existingIds: string[]): string {
  const existing = new Set(existingIds);
  if (!existing.has(baseId)) {
    return baseId;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function nextLabel(labels: string[]): string {
  const used = new Set(labels);
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const label = String.fromCharCode(code);
    if (!used.has(label)) {
      return label;
    }
  }
  return "Z";
}

function advanceTimestamp(previous: string, supplied: string): SessionStateResult<string> {
  const previousMilliseconds = Date.parse(previous);
  const suppliedMilliseconds = Date.parse(supplied);
  if (!Number.isFinite(previousMilliseconds) || !Number.isFinite(suppliedMilliseconds)) {
    return failure("INVALID_SESSION_FILE", "Could not advance annotation timestamp safely.");
  }
  if (suppliedMilliseconds > previousMilliseconds) {
    return { ok: true, value: supplied };
  }
  const advancedMilliseconds = previousMilliseconds + 1;
  if (!Number.isFinite(advancedMilliseconds) || advancedMilliseconds > 8_640_000_000_000_000) {
    return failure("INVALID_SESSION_FILE", "Could not advance annotation timestamp safely.");
  }
  return { ok: true, value: new Date(advancedMilliseconds).toISOString() };
}

function upgradeFileToV3(
  file: CaptureSessionFileV1 | CaptureSessionFileV2,
  createAnnotationId: () => string,
): SessionStateResult<CaptureSessionFileV3> {
  const annotationIds = file.schemaVersion === "0.2.0"
    ? file.session.attachments.map((item) => item.annotationId)
    : [];
  const attachments: CaptureSessionFileV3["session"]["attachments"] = [];
  for (const item of file.session.attachments) {
    if (file.schemaVersion === "0.2.0") {
      const currentItem = item as CaptureSessionFileV2["session"]["attachments"][number];
      attachments.push({
        ...currentItem,
        annotationLifecycle: { state: "open", resolvedAt: null },
      });
      continue;
    }
    const annotationId = createUniqueAnnotationId(annotationIds, createAnnotationId);
    if (!annotationId.ok) return annotationId;
    annotationIds.push(annotationId.value);
    attachments.push({
      ...item,
      annotationId: annotationId.value,
      updatedAt: item.createdAt,
      annotationLifecycle: { state: "open", resolvedAt: null },
    });
  }
  return {
    ok: true,
    value: {
      ...file,
      schemaVersion: "0.3.0",
      session: {
        ...file.session,
        attachments,
      },
    },
  };
}

function sessionItemAnnotationId(
  item: CaptureSessionFile["session"]["attachments"][number],
): string | null {
  return "annotationId" in item && typeof item.annotationId === "string"
    ? item.annotationId
    : null;
}

function receiptMatchesSessionItem(
  receipt: CaptureReceipt,
  item: CaptureSessionFile["session"]["attachments"][number],
): boolean {
  const currentAnnotationId = sessionItemAnnotationId(item);
  if (!Object.hasOwn(receipt, "annotationId")) {
    return currentAnnotationId === null;
  }
  return receipt.annotationId === currentAnnotationId;
}

function createUniqueAnnotationId(
  existingIds: readonly string[],
  createAnnotationId: () => string,
): SessionStateResult<string> {
  const existing = new Set(existingIds);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    let candidate: string;
    try {
      candidate = createAnnotationId();
    } catch {
      return failure("INVALID_SESSION_FILE", "Could not allocate a unique annotation identity.");
    }
    if (isCaptureSessionAnnotationId(candidate) && !existing.has(candidate)) {
      return { ok: true, value: candidate };
    }
  }
  return failure("INVALID_SESSION_FILE", "Could not allocate a unique annotation identity.");
}

function defaultCreateAnnotationId(): string {
  return crypto.randomUUID();
}

function failure(
  code: SessionStateErrorCode,
  error: string,
): { ok: false; code: SessionStateErrorCode; error: string } {
  return { ok: false, code, error };
}
