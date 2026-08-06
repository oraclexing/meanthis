import type { CaptureSessionFileV1 } from "@meanthis/hub-core";
import type { OriginCaptureRecord } from "./capture-store";
import {
  EXTENSION_SESSION_MAX_ITEMS,
  serializeCaptureSessionFile,
  toSessionFileSourceRecord,
} from "./session-file";

export interface CaptureReceipt {
  operationId: string;
  itemId: string;
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
  file: CaptureSessionFileV1 | null;
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
): SessionStateResult<CaptureToken> {
  const normalized = normalizeState(state);
  if (!normalized.ok) return normalized;
  if (normalized.value.meta.clearPending) {
    return failure("CLEAR_IN_PROGRESS", "A session clear is already in progress.");
  }
  if (normalized.value.file && normalized.value.file.session.origin !== origin) {
    return failure("STALE_SESSION", "Capture origin does not match the active session.");
  }
  return {
    ok: true,
    value: { origin, epoch: normalized.value.meta.epoch, operationId },
  };
}

export function commitCapture(
  state: SessionState,
  token: CaptureToken,
  record: OriginCaptureRecord,
  committedAt: string,
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
    if (
      !next.file?.session.attachments.some((item) => item.id === existingReceipt.itemId)
    ) {
      return failure("ITEM_NOT_FOUND", "Receipt item is no longer present in the session.");
    }
    next.meta.receipts = appendReceipt(
      next.meta.receipts,
      captureToken.operationId,
      existingReceipt.itemId,
    );
    return { ok: true, value: next };
  }

  const sourceRecord = toSessionFileSourceRecord(captureRecord);
  const recapturedItem = next.file?.session.attachments.find(
    (item) => isSameVerifiedTarget(item.sourceRecord, sourceRecord),
  );
  if (next.file && recapturedItem) {
    const file: CaptureSessionFileV1 = {
      ...next.file,
      session: {
        ...next.file.session,
        updatedAt: maxTimestamp(next.file.session.updatedAt, committedAt),
        attachments: next.file.session.attachments.map((item) => (
          item.id === recapturedItem.id
            ? {
                ...item,
                sourceRecord: {
                  ...sourceRecord,
                  intent: item.sourceRecord.intent,
                },
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
      recapturedItem.id,
    );
    return { ok: true, value: next };
  }

  if (next.file && next.file.session.attachments.length >= EXTENSION_SESSION_MAX_ITEMS) {
    return failure("SESSION_FULL", "Capture session already contains 26 items.");
  }

  const itemId = nextAttachmentId(
    sourceRecord.attachment.id,
    next.file?.session.attachments.map((item) => item.id) ?? [],
  );
  const item = {
    id: itemId,
    createdAt: committedAt,
    labels: [nextLabel(next.file?.session.attachments.flatMap((entry) => entry.labels) ?? [])],
    sourceRecord,
  };
  const file: CaptureSessionFileV1 =
    next.file === null
      ? {
          schemaVersion: "0.1.0",
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
          ...next.file,
          session: {
            ...next.file.session,
            updatedAt: maxTimestamp(next.file.session.updatedAt, committedAt),
            attachments: [...next.file.session.attachments, item],
          },
        };

  const serialized = serializeCaptureSessionFile(file);
  if (!serialized.ok) {
    return serialized;
  }
  next.file = serialized.value.file;
  next.meta.receipts = appendReceipt(next.meta.receipts, captureToken.operationId, itemId);
  return { ok: true, value: next };
}

export function updateSessionIntent(
  state: SessionState,
  epoch: string,
  itemId: string,
  intent: string,
  updatedAt: string,
): SessionStateResult<SessionState> {
  const normalized = normalizeMutableSession(state, epoch);
  if (!normalized.ok) return normalized;
  const next = normalized.value;
  const item = next.file.session.attachments.find((entry) => entry.id === itemId);
  if (!item) {
    return failure("ITEM_NOT_FOUND", "Capture session item was not found.");
  }
  if (item.sourceRecord.intent !== intent) {
    item.sourceRecord.intent = intent;
    next.file.session.updatedAt = maxTimestamp(next.file.session.updatedAt, updatedAt);
  }
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
  const before = next.file.session.attachments.length;
  next.file.session.attachments = next.file.session.attachments.filter(
    (entry) => entry.id !== itemId,
  );
  if (next.file.session.attachments.length === before) {
    return serializeState(next);
  }
  next.file.session.updatedAt = maxTimestamp(next.file.session.updatedAt, updatedAt);
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
): SessionStateResult<SessionState & { file: CaptureSessionFileV1 }> {
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
  return { ok: true, value: normalized.value as SessionState & { file: CaptureSessionFileV1 } };
}

function normalizeState(state: SessionState): SessionStateResult<SessionState> {
  const next = structuredClone(state);
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
): CaptureReceipt[] {
  return [
    ...receipts.filter((receipt) => receipt.operationId !== operationId),
    { operationId, itemId },
  ].slice(-64);
}

function trimReceipts(receipts: CaptureReceipt[]): CaptureReceipt[] {
  return receipts.slice(-64);
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

function isSameVerifiedTarget(
  left: CaptureSessionFileV1["session"]["attachments"][number]["sourceRecord"],
  right: CaptureSessionFileV1["session"]["attachments"][number]["sourceRecord"],
): boolean {
  const leftKey = verifiedTargetKey(left);
  return leftKey !== null && leftKey === verifiedTargetKey(right);
}

function verifiedTargetKey(
  record: CaptureSessionFileV1["session"]["attachments"][number]["sourceRecord"],
): string | null {
  const tabId = record.tabId;
  const frameId = record.frameId ?? 0;
  const identityAttempt = findVerifiedTestIdAttempt(record);
  if (
    typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0 ||
    !Number.isInteger(frameId) || frameId < 0 ||
    identityAttempt === null
  ) {
    return null;
  }
  let pathname: string;
  try {
    const pageUrl = new URL(record.pageUrl ?? "");
    if (pageUrl.origin !== record.origin) return null;
    pathname = pageUrl.pathname;
  } catch {
    return null;
  }
  return JSON.stringify([
    tabId,
    frameId,
    record.origin,
    pathname,
    record.attachment.id,
    identityAttempt.strategy,
    identityAttempt.value,
  ]);
}

function findVerifiedTestIdAttempt(
  record: CaptureSessionFileV1["session"]["attachments"][number]["sourceRecord"],
): { strategy: "playwright.testId"; value: string } | null {
  const locatorValues = new Set([
    ...(record.attachment.locatorBundle.primary
      ? [record.attachment.locatorBundle.primary]
      : []),
    ...record.attachment.locatorBundle.candidates,
  ].filter((locator) => locator.strategy === "playwright.testId").map((locator) => locator.value));
  for (const attempt of record.replayAttempts ?? []) {
    if (typeof attempt !== "object" || attempt === null) continue;
    const candidate = attempt as Record<string, unknown>;
    if (
      candidate.strategy === "playwright.testId" &&
      typeof candidate.value === "string" && candidate.value.length > 0 &&
      locatorValues.has(candidate.value) &&
      candidate.replayVerified === true &&
      candidate.uniqueness === true &&
      candidate.matchCount === 1 &&
      candidate.visible === true
    ) {
      return { strategy: "playwright.testId", value: candidate.value };
    }
  }
  return null;
}

function maxTimestamp(previous: string, supplied: string): string {
  return previous >= supplied ? previous : supplied;
}

function failure(
  code: SessionStateErrorCode,
  error: string,
): { ok: false; code: SessionStateErrorCode; error: string } {
  return { ok: false, code, error };
}
