import type { CaptureSessionFileV1 } from "@meanthis/hub-core";
import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import type { ActivePageContext, ActiveSessionCommandData, SessionCommandResponse } from "./messages";
import {
  serializeCaptureSessionFile,
  type SessionFileResult,
} from "./session-file";
import type { ActiveSessionReadback } from "./session-store";
import {
  findPanelSessionItem,
  selectInitialSessionItemId,
} from "./panel-session-model";

export interface PanelSessionSnapshot {
  activeSupported: boolean;
  activePage: ActivePageContext | null;
  clearPending: boolean;
  sessionMutationPending: boolean;
  origin: string | null;
  epoch: string | null;
  file: CaptureSessionFileV1 | null;
  legacyRecord: OriginCaptureRecord | null;
  selectedItemId: string | null;
  viewMode: UIAttachmentDisclosureMode;
  intent: string;
  intentDirty: boolean;
  status: {
    kind: "empty" | "error" | "ready" | "saving" | "success";
    message: string;
  };
  recovery: null | {
    oldOrigin: string;
    oldEpoch: string;
    itemId: string;
    intent: string;
    pendingOrigin: string | null;
  };
}

export interface PanelSessionController {
  subscribe(listener: (snapshot: PanelSessionSnapshot) => void): () => void;
  initialize(): Promise<void>;
  refreshActiveOrigin(preferredCaptureItemId?: string): Promise<void>;
  selectItem(itemId: string): Promise<void>;
  setIntent(intent: string): void;
  flushIntent(): Promise<boolean>;
  retryDirtyIntent(): Promise<void>;
  discardDirtyIntent(): Promise<void>;
  removeItem(itemId: string): Promise<void>;
  clearSession(operationId: string): Promise<void>;
  readExport(): Promise<SessionFileResult<{ file: CaptureSessionFileV1; text: string; byteLength: number }>>;
  setViewMode(mode: UIAttachmentDisclosureMode): void;
  getSnapshot(): PanelSessionSnapshot;
}

export interface PanelSessionClient {
  getActive(): Promise<SessionCommandResponse<ActiveSessionCommandData>>;
  updateIntent(
    origin: string,
    epoch: string,
    itemId: string,
    intent: string,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>>;
  removeItem(
    origin: string,
    epoch: string,
    itemId: string,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>>;
  clear(
    origin: string,
    epoch: string | null,
    operationId: string,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>>;
}

interface PanelSessionControllerOptions {
  client: PanelSessionClient;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(id: unknown): void;
}

interface SessionMutation {
  id: number;
  origin: string;
  epoch: string | null;
}

const DEBOUNCE_MS = 250;
const SAFE_PANEL_ERROR = "Panel action failed. Try again.";

export function createPanelSessionController(
  options: PanelSessionControllerOptions,
): PanelSessionController {
  const listeners = new Set<(snapshot: PanelSessionSnapshot) => void>();
  let snapshot = createEmptySnapshot();
  let debounceId: unknown = null;
  let pendingClearOperationId: string | null = null;
  let intentRevision = 0;
  let stateRevision = 0;
  let refreshRequestSequence = 0;
  let lastFlushBlockMessage = "";
  let mutationSequence = 0;
  const activeMutations = new Set<number>();
  const lastSelectedItemByPage = new Map<string, string>();

  function emit(): void {
    const next = cloneSnapshot(snapshot);
    for (const listener of listeners) {
      listener(next);
    }
  }

  function setStatus(kind: PanelSessionSnapshot["status"]["kind"], message: string): void {
    snapshot = { ...snapshot, status: { kind, message } };
    stateRevision += 1;
  }

  function beginMutation(
    message: string,
    target: { origin: string; epoch: string | null },
  ): SessionMutation {
    const id = ++mutationSequence;
    activeMutations.add(id);
    snapshot = { ...snapshot, sessionMutationPending: true };
    setStatus("saving", message);
    emit();
    return { id, origin: target.origin, epoch: target.epoch };
  }

  function finishMutation(mutation: { id: number }): boolean {
    activeMutations.delete(mutation.id);
    if (activeMutations.size === 0 && snapshot.sessionMutationPending) {
      snapshot = { ...snapshot, sessionMutationPending: false };
      stateRevision += 1;
      return true;
    }
    return false;
  }

  function isMutationCurrent(mutation: SessionMutation): boolean {
    return (
      activeMutations.has(mutation.id) &&
      snapshot.origin === mutation.origin &&
      snapshot.epoch === mutation.epoch
    );
  }

  function isClearReconciliationCurrent(mutation: SessionMutation): boolean {
    return snapshot.origin === mutation.origin && snapshot.epoch === mutation.epoch;
  }

  function isActiveDataForMutationOrigin(
    data: ActiveSessionCommandData,
    mutation: SessionMutation,
  ): boolean {
    return data.origin === mutation.origin || data.readback?.origin === mutation.origin;
  }

  function cancelDebounce(): void {
    if (debounceId !== null) {
      options.clearTimeout(debounceId);
      debounceId = null;
    }
  }

  async function loadActive(): Promise<SessionCommandResponse<ActiveSessionCommandData>> {
    const active = await options.client.getActive();
    if (!active.ok) {
      setStatus("error", active.error);
      emit();
    }
    return active;
  }

  function applyActiveData(data: ActiveSessionCommandData, preferredItemId?: string | null): void {
    if (!data.enabled || !data.origin) {
      applyUnsupportedActive();
      return;
    }
    if (!data.readback) {
      applyNoSession(data.origin, data.activePage);
      return;
    }
    const rememberedItemId = preferredItemId === undefined
      ? data.selectedItemId ?? getRememberedPageSelection(data.activePage)
      : preferredItemId;
    applyActive(data.readback, rememberedItemId, data.activePage);
  }

  function getRememberedPageSelection(activePage: ActivePageContext | null): string | undefined {
    const key = activePageSelectionKey(activePage);
    return key === null ? undefined : lastSelectedItemByPage.get(key);
  }

  function rememberPageSelection(
    activePage: ActivePageContext | null,
    selectedItemId: string | null,
  ): void {
    const key = activePageSelectionKey(activePage);
    if (key === null || selectedItemId === null) return;
    lastSelectedItemByPage.set(key, selectedItemId);
  }

  function applyUnsupportedActive(): void {
    pendingClearOperationId = null;
    snapshot = {
      ...createEmptySnapshot(),
      viewMode: snapshot.viewMode,
      activeSupported: false,
      sessionMutationPending: activeMutations.size > 0,
      status: {
        kind: "empty",
        message: "This page is not supported. Open an HTTP(S) page to capture UI.",
      },
    };
    stateRevision += 1;
    emit();
  }

  function applyNoSession(origin: string, activePage: ActivePageContext | null): void {
    pendingClearOperationId = null;
    snapshot = {
      ...createEmptySnapshot(),
      viewMode: snapshot.viewMode,
      activeSupported: true,
      activePage,
      sessionMutationPending: activeMutations.size > 0,
      origin,
      status: {
        kind: "empty",
        message: "No session for this origin. Capture an element to start one.",
      },
    };
    stateRevision += 1;
    emit();
  }

  function applyActive(
    readback: ActiveSessionReadback | null,
    preferredItemId?: string | null,
    activePage: ActivePageContext | null = snapshot.activePage,
  ): void {
    if (!readback) {
      pendingClearOperationId = null;
      snapshot = {
        ...createEmptySnapshot(),
        viewMode: snapshot.viewMode,
        sessionMutationPending: activeMutations.size > 0,
      };
      stateRevision += 1;
      emit();
      return;
    }
    if (!readback.clearPending) {
      pendingClearOperationId = null;
    } else if (readback.activeClearOperationId !== null) {
      pendingClearOperationId = readback.activeClearOperationId;
    }

    const file = cloneNullable(readback.file);
    const legacyRecord = cloneNullable(readback.legacyRecord);
    const selectedItemId = chooseSelectedItemId(file, preferredItemId, activePage);
    const selectedItem = findPanelSessionItem(file, selectedItemId);
    rememberPageSelection(activePage, selectedItemId);
    const hasSessionItems = (file?.session.attachments.length ?? 0) > 0;
    snapshot = {
      ...snapshot,
      activeSupported: true,
      activePage,
      clearPending: readback.clearPending,
      sessionMutationPending: activeMutations.size > 0,
      origin: readback.origin,
      epoch: readback.epoch,
      file,
      legacyRecord,
      selectedItemId,
      intent: selectedItem?.sourceRecord.intent ?? "",
      intentDirty: false,
      recovery: null,
      status: readback.clearPending
        ? { kind: "saving", message: "A session clear is already in progress." }
        : hasSessionItems
          ? { kind: "ready", message: "Capture session ready." }
          : readback.legacyRecord
            ? { kind: "ready", message: "Selected element preview ready." }
            : {
                kind: "empty",
                message: "No session for this origin. Capture an element to start one.",
              },
    };
    stateRevision += 1;
    emit();
  }

  function getCurrentMutationTarget(): { origin: string; epoch: string; itemId: string } | null {
    if (!snapshot.origin || !snapshot.epoch || !snapshot.selectedItemId) return null;
    return {
      origin: snapshot.origin,
      epoch: snapshot.epoch,
      itemId: snapshot.selectedItemId,
    };
  }

  function isStillCurrentIntentTarget(
    target: { origin: string; epoch: string; itemId: string },
    intent: string,
    revision: number,
  ): boolean {
    return (
      snapshot.origin === target.origin &&
      snapshot.epoch === target.epoch &&
      snapshot.selectedItemId === target.itemId &&
      snapshot.intent === intent &&
      snapshot.intentDirty &&
      intentRevision === revision
    );
  }

  async function flushCurrentIntent(): Promise<boolean> {
    lastFlushBlockMessage = "";
    if (!snapshot.intentDirty) return true;
    if (snapshot.recovery) {
      lastFlushBlockMessage = "Resolve the unsaved intent before changing this session.";
      setStatus("error", lastFlushBlockMessage);
      emit();
      return false;
    }

    const target = getCurrentMutationTarget();
    if (!target) {
      snapshot = { ...snapshot, intentDirty: false };
      stateRevision += 1;
      emit();
      return true;
    }

    const capturedIntent = snapshot.intent;
    const capturedRevision = intentRevision;
    cancelDebounce();
    setStatus("saving", "Saving intent.");
    emit();
    const response = await options.client.updateIntent(
      target.origin,
      target.epoch,
      target.itemId,
      capturedIntent,
    );
    if (!isStillCurrentIntentTarget(target, capturedIntent, capturedRevision)) {
      lastFlushBlockMessage = "Intent changed before export. Save again and retry.";
      return false;
    }
    if (!response.ok) {
      lastFlushBlockMessage = response.error;
      setStatus("error", response.error);
      emit();
      return false;
    }

    applyActive(response.data, target.itemId);
    setStatus("success", "Intent saved.");
    emit();
    return true;
  }

  async function callClear(
    origin: string,
    epoch: string | null,
    operationId: string,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    try {
      return await options.client.clear(origin, epoch, operationId);
    } catch {
      return {
        ok: false,
        code: "RUNTIME_ERROR",
        error: SAFE_PANEL_ERROR,
      };
    }
  }

  async function reconcileClearFailure(
    originalError: string,
    stableOperationId: string,
    mutation: SessionMutation,
  ): Promise<void> {
    if (!isClearReconciliationCurrent(mutation)) return;

    let active: SessionCommandResponse<ActiveSessionCommandData>;
    try {
      active = await options.client.getActive();
    } catch {
      pendingClearOperationId = stableOperationId;
      setStatus("error", SAFE_PANEL_ERROR);
      emit();
      return;
    }

    if (!active.ok) {
      pendingClearOperationId = stableOperationId;
      setStatus("error", SAFE_PANEL_ERROR);
      emit();
      return;
    }

    if (
      !isClearReconciliationCurrent(mutation) ||
      !isActiveDataForMutationOrigin(active.data, mutation)
    ) {
      return;
    }

    const readback = active.data.readback;
    applyActiveData(active.data);
    if (readback?.clearPending) {
      pendingClearOperationId = readback.activeClearOperationId ?? stableOperationId;
      return;
    }

    pendingClearOperationId = null;
    setStatus("error", originalError);
    emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(cloneSnapshot(snapshot));
      return () => {
        listeners.delete(listener);
      };
    },

    async initialize() {
      const active = await loadActive();
      if (!active.ok) return;
      applyActiveData(active.data);
    },

    async refreshActiveOrigin(preferredCaptureItemId) {
      cancelDebounce();
      const requestId = ++refreshRequestSequence;
      const startStateRevision = stateRevision;
      const startActivePage = snapshot.activePage;
      if (snapshot.recovery) {
        setStatus("error", "Resolve the unsaved intent before changing this session.");
        emit();
        return;
      }

      if (snapshot.intentDirty) {
        const oldTarget = getCurrentMutationTarget();
        const capturedIntent = snapshot.intent;
        const capturedRevision = intentRevision;
        const active = await options.client.getActive();
        if (requestId !== refreshRequestSequence) return;
        if (stateRevision !== startStateRevision) return;
        if (!active.ok) {
          setStatus("error", active.error);
          emit();
          return;
        }
        const activeCaptureItemId = getActiveCaptureItemId(active.data, preferredCaptureItemId);
        if (!oldTarget) return;
        const response = await options.client.updateIntent(
          oldTarget.origin,
          oldTarget.epoch,
          oldTarget.itemId,
          capturedIntent,
        );
        if (requestId !== refreshRequestSequence) return;
        if (!isStillCurrentIntentTarget(oldTarget, capturedIntent, capturedRevision)) return;
        if (!response.ok) {
          snapshot = {
            ...snapshot,
            recovery: {
              oldOrigin: oldTarget.origin,
              oldEpoch: oldTarget.epoch,
              itemId: oldTarget.itemId,
              intent: capturedIntent,
              pendingOrigin: active.data.origin,
            },
            status: { kind: "error", message: response.error },
          };
          stateRevision += 1;
          emit();
          return;
        }
        if (stateRevision !== startStateRevision) return;
        const activeOrigin = active.data.origin ?? active.data.readback?.origin ?? null;
        if (activeOrigin === oldTarget.origin) {
          const preferredItemId = activeCaptureItemId ?? (
            sameActivePage(startActivePage, active.data.activePage)
              ? oldTarget.itemId
              : undefined
          );
          applyActive(response.data, preferredItemId, active.data.activePage);
        } else {
          applyActiveData(active.data, activeCaptureItemId);
        }
        return;
      }

      const active = await options.client.getActive();
      if (requestId !== refreshRequestSequence || stateRevision !== startStateRevision) return;
      if (!active.ok) {
        setStatus("error", active.error);
        emit();
        return;
      }
      const activeCaptureItemId = getActiveCaptureItemId(active.data, preferredCaptureItemId);
      const preferredItemId = activeCaptureItemId ?? (
        sameActivePage(startActivePage, active.data.activePage)
          ? snapshot.selectedItemId
          : undefined
      );
      applyActiveData(active.data, preferredItemId);
    },

    async selectItem(itemId) {
      if (snapshot.clearPending) {
        setStatus("saving", "A session clear is already in progress.");
        emit();
        return;
      }
      if (snapshot.recovery) {
        setStatus("error", "Resolve the unsaved intent before changing this session.");
        emit();
        return;
      }
      if (!(await flushCurrentIntent())) return;
      const item = findPanelSessionItem(snapshot.file, itemId);
      if (!item) return;
      snapshot = {
        ...snapshot,
        selectedItemId: item.id,
        intent: item.sourceRecord.intent,
        intentDirty: false,
        status: { kind: "ready", message: "Capture session ready." },
      };
      rememberPageSelection(snapshot.activePage, item.id);
      stateRevision += 1;
      emit();
    },

    setIntent(intent) {
      if (snapshot.sessionMutationPending) {
        return;
      }
      if (snapshot.clearPending) {
        setStatus("saving", "A session clear is already in progress.");
        emit();
        return;
      }
      if (snapshot.recovery) {
        setStatus("error", "Resolve the unsaved intent before changing this session.");
        emit();
        return;
      }
      snapshot = {
        ...snapshot,
        intent,
        intentDirty: true,
        status: { kind: "ready", message: "Unsaved intent." },
      };
      intentRevision += 1;
      stateRevision += 1;
      cancelDebounce();
      debounceId = options.setTimeout(() => {
        debounceId = null;
        void flushCurrentIntent();
      }, DEBOUNCE_MS);
      emit();
    },

    flushIntent() {
      return flushCurrentIntent();
    },

    async retryDirtyIntent() {
      const recovery = snapshot.recovery;
      if (!recovery) {
        await flushCurrentIntent();
        return;
      }
      setStatus("saving", "Saving recovered intent.");
      emit();
      const response = await options.client.updateIntent(
        recovery.oldOrigin,
        recovery.oldEpoch,
        recovery.itemId,
        recovery.intent,
      );
      if (!response.ok) {
        setStatus("error", response.error);
        emit();
        return;
      }

      snapshot = { ...snapshot, recovery: null, intentDirty: false };
      stateRevision += 1;
      if (recovery.pendingOrigin) {
        const active = await loadActive();
        if (active.ok) {
          applyActiveData(active.data);
        }
        return;
      }
      applyActive(response.data, recovery.itemId);
    },

    async discardDirtyIntent() {
      cancelDebounce();
      if (snapshot.recovery) {
        const recovery = snapshot.recovery;
        const active = await loadActive();
        const activeOrigin = active.ok ? active.data.origin ?? active.data.readback?.origin ?? null : null;
        if (
          active.ok &&
          (!recovery.pendingOrigin || activeOrigin === recovery.pendingOrigin)
        ) {
          snapshot = { ...snapshot, recovery: null, intentDirty: false };
          stateRevision += 1;
          applyActiveData(active.data);
        } else if (active.ok) {
          snapshot = {
            ...snapshot,
            recovery,
            status: {
              kind: "error",
              message: "Active origin changed again. Refresh before discarding the recovered intent.",
            },
          };
          stateRevision += 1;
          emit();
        }
        return;
      }
      const item = findPanelSessionItem(snapshot.file, snapshot.selectedItemId);
      snapshot = {
        ...snapshot,
        intent: item?.sourceRecord.intent ?? "",
        intentDirty: false,
        status: { kind: "ready", message: "Capture session ready." },
      };
      stateRevision += 1;
      emit();
    },

    async removeItem(itemId) {
      if (snapshot.clearPending) {
        setStatus("saving", "A session clear is already in progress.");
        emit();
        return;
      }
      if (snapshot.recovery) {
        setStatus("error", "Resolve the unsaved intent before changing this session.");
        emit();
        return;
      }
      if (snapshot.intentDirty && itemId === snapshot.selectedItemId) {
        setStatus("error", "Discard the unsaved selected intent before changing this session.");
        emit();
        return;
      }
      if (!(await flushCurrentIntent())) return;
      const target = getCurrentMutationTarget();
      if (!target) return;
      const preferred = choosePostRemoveSelection(snapshot.file, snapshot.selectedItemId, itemId);
      const mutation = beginMutation("Removing session item.", target);
      const response = await options.client.removeItem(target.origin, target.epoch, itemId);
      const current = isMutationCurrent(mutation);
      const pendingChanged = finishMutation(mutation);
      if (!current) {
        if (pendingChanged) emit();
        return;
      }
      if (!response.ok) {
        setStatus("error", response.error);
        emit();
        return;
      }
      applyActive(response.data, preferred);
      setStatus("success", "Session item removed.");
      emit();
    },

    async clearSession(operationId) {
      if (snapshot.recovery) {
        setStatus("error", "Resolve the unsaved intent before changing this session.");
        emit();
        return;
      }
      if (snapshot.intentDirty) {
        setStatus("error", "Discard the unsaved selected intent before changing this session.");
        emit();
        return;
      }
      if (!snapshot.origin) return;
      pendingClearOperationId = pendingClearOperationId ?? operationId;
      const stableOperationId = pendingClearOperationId;
      const target = { origin: snapshot.origin, epoch: snapshot.epoch };
      const mutation = beginMutation("Clearing capture session.", target);
      const response = await callClear(snapshot.origin, snapshot.epoch, stableOperationId);
      const current = isMutationCurrent(mutation);
      const pendingChanged = finishMutation(mutation);
      if (!current) {
        if (pendingChanged) emit();
        return;
      }
      if (!response.ok) {
        if (response.code === "CLEAR_IN_PROGRESS") {
          snapshot = { ...snapshot, clearPending: true };
          setStatus("saving", response.error);
          emit();
          return;
        }
        await reconcileClearFailure(response.error, stableOperationId, mutation);
        return;
      }
      pendingClearOperationId = null;
      applyActive(response.data);
      setStatus("success", "Session cleared.");
      emit();
    },

    async readExport() {
      if (snapshot.recovery) {
        return invalidExport("Resolve the unsaved intent before exporting.");
      }
      if (snapshot.clearPending) {
        return invalidExport("Session clear is still in progress. Try again after it finishes.");
      }
      if (activeMutations.size > 0) {
        return invalidExport("Session mutation is still in progress. Try again after it finishes.");
      }
      if (!(await flushCurrentIntent())) {
        return invalidExport(lastFlushBlockMessage || snapshot.status.message);
      }
      if (activeMutations.size > 0) {
        return invalidExport("Session mutation is still in progress. Try again after it finishes.");
      }
      const exportStateRevision = stateRevision;
      const renderedOrigin = snapshot.origin;
      const renderedEpoch = snapshot.epoch;
      const active = await options.client.getActive();
      if (stateRevision !== exportStateRevision) {
        return invalidExport("Panel state changed before export. Save again and retry.");
      }
      if (!active.ok) return invalidExport(active.error);
      const readback = active.data.readback;
      if (!readback || !readback.file) {
        return invalidExport("No active capture session to export.");
      }
      if (readback.clearPending) {
        return invalidExport("Session clear is still in progress. Try again after it finishes.");
      }
      if (readback.origin !== renderedOrigin || active.data.origin !== renderedOrigin) {
        return invalidExport("Active origin changed before export. Refresh the panel and try again.");
      }
      if (readback.epoch !== renderedEpoch) {
        return invalidExport("Capture session changed before export. Refresh the panel and try again.");
      }
      applyActive(readback, snapshot.selectedItemId);
      return serializeCaptureSessionFile(readback.file);
    },

    setViewMode(mode) {
      snapshot = { ...snapshot, viewMode: mode };
      stateRevision += 1;
      emit();
    },

    getSnapshot() {
      return cloneSnapshot(snapshot);
    },
  };
}

function createEmptySnapshot(): PanelSessionSnapshot {
  return {
    activeSupported: false,
    activePage: null,
    clearPending: false,
    sessionMutationPending: false,
    origin: null,
    epoch: null,
    file: null,
    legacyRecord: null,
    selectedItemId: null,
    viewMode: "agent_safe",
    intent: "",
    intentDirty: false,
    status: {
      kind: "empty",
      message: "No active capture session.",
    },
    recovery: null,
  };
}

function chooseSelectedItemId(
  file: CaptureSessionFileV1 | null,
  preferredItemId: string | null | undefined,
  activePage: ActivePageContext | null,
): string | null {
  if (!file || file.session.attachments.length === 0) return null;
  if (preferredItemId && file.session.attachments.some((item) => item.id === preferredItemId)) {
    return preferredItemId;
  }
  return selectInitialSessionItemId(file, activePage);
}

function choosePostRemoveSelection(
  file: CaptureSessionFileV1 | null,
  selectedItemId: string | null,
  removedItemId: string,
): string | null {
  if (!file || selectedItemId !== removedItemId) return selectedItemId;
  const index = file.session.attachments.findIndex((item) => item.id === removedItemId);
  if (index < 0) return selectedItemId;
  return file.session.attachments[index + 1]?.id ?? file.session.attachments[index - 1]?.id ?? null;
}

function sameActivePage(
  left: ActivePageContext | null,
  right: ActivePageContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return activePageSelectionKey(left) === activePageSelectionKey(right);
}

function activePageSelectionKey(activePage: ActivePageContext | null): string | null {
  if (!activePage) return null;
  return JSON.stringify([
    activePage.tabId,
    activePage.frameId,
    activePage.origin,
    activePage.pathname,
  ]);
}

function getActiveCaptureItemId(
  data: ActiveSessionCommandData,
  preferredCaptureItemId: string | undefined,
): string | undefined {
  if (!preferredCaptureItemId || !data.activePage || !data.readback?.file) return undefined;
  const item = findPanelSessionItem(data.readback.file, preferredCaptureItemId);
  if (!item) return undefined;
  const record = item.sourceRecord as OriginCaptureRecord;
  let pathname: string;
  try {
    pathname = new URL(record.pageUrl ?? "").pathname;
  } catch {
    return undefined;
  }
  return record.tabId === data.activePage.tabId &&
    (record.frameId ?? 0) === data.activePage.frameId &&
    record.origin === data.activePage.origin &&
    pathname === data.activePage.pathname
    ? preferredCaptureItemId
    : undefined;
}

function invalidExport(error: string): SessionFileResult<{
  file: CaptureSessionFileV1;
  text: string;
  byteLength: number;
}> {
  return {
    ok: false,
    code: "INVALID_SESSION_FILE",
    error,
  };
}

function cloneSnapshot(snapshot: PanelSessionSnapshot): PanelSessionSnapshot {
  return {
    ...snapshot,
    activePage: snapshot.activePage ? { ...snapshot.activePage } : null,
    file: cloneNullable(snapshot.file),
    legacyRecord: cloneNullable(snapshot.legacyRecord),
    status: { ...snapshot.status },
    recovery: snapshot.recovery ? { ...snapshot.recovery } : null,
  };
}

function cloneNullable<T>(value: T | null): T | null {
  return value === null ? null : structuredClone(value);
}
