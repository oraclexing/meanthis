import type {
  CaptureSessionAnnotationLifecycleStateV3,
  CaptureSessionFile,
} from "@meanthis/hub-core";
import {
  validateMetadataDiagnosticsV1,
  type MetadataDiagnosticsV1,
  type UIAttachmentDisclosureMode,
} from "@meanthis/schema";
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
  activeClearOperationId: string | null;
  sessionMutationPending: boolean;
  origin: string | null;
  epoch: string | null;
  file: CaptureSessionFile | null;
  legacyRecord: OriginCaptureRecord | null;
  currentItemIds: readonly string[] | null;
  metadataDiagnostics: MetadataDiagnosticsV1 | null;
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
  setAnnotationLifecycle(
    itemId: string,
    nextState: CaptureSessionAnnotationLifecycleStateV3,
  ): Promise<void>;
  removeItem(itemId: string): Promise<void>;
  clearSession(operationId: string, scope?: PanelSessionClearScope): Promise<void>;
  readExport(): Promise<SessionFileResult<{ file: CaptureSessionFile; text: string; byteLength: number }>>;
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
  updateAnnotationLifecycle(
    origin: string,
    epoch: string,
    itemId: string,
    annotationId: string,
    expectedState: CaptureSessionAnnotationLifecycleStateV3,
    nextState: CaptureSessionAnnotationLifecycleStateV3,
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
    scope?: PanelSessionClearScope,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>>;
}

export type PanelSessionClearScope = "live-page" | "active-origin";

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

interface SnapshotRequest {
  revision: number;
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
  let snapshotRequestRevision = 0;
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

  function beginSnapshotRequest(): SnapshotRequest {
    return { revision: ++snapshotRequestRevision };
  }

  function isSnapshotRequestCurrent(request: SnapshotRequest): boolean {
    return request.revision === snapshotRequestRevision;
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

  function isMutationCurrent(mutation: SessionMutation, request: SnapshotRequest): boolean {
    return (
      isSnapshotRequestCurrent(request) &&
      activeMutations.has(mutation.id) &&
      snapshot.origin === mutation.origin &&
      snapshot.epoch === mutation.epoch
    );
  }

  function isClearReconciliationCurrent(
    mutation: SessionMutation,
    request: SnapshotRequest,
  ): boolean {
    return isSnapshotRequestCurrent(request) &&
      snapshot.origin === mutation.origin && snapshot.epoch === mutation.epoch;
  }

  function isActiveDataForMutationOrigin(
    data: ActiveSessionCommandData,
    mutation: SessionMutation,
  ): boolean {
    const readback = data.readback === null
      ? null
      : parseAuthoritativeActiveSessionReadback(data.readback);
    return data.origin === mutation.origin || readback?.origin === mutation.origin;
  }

  function cancelDebounce(): void {
    if (debounceId !== null) {
      options.clearTimeout(debounceId);
      debounceId = null;
    }
  }

  async function loadActive(
    request: SnapshotRequest,
  ): Promise<SessionCommandResponse<ActiveSessionCommandData> | null> {
    const active = await options.client.getActive();
    if (!isSnapshotRequestCurrent(request)) return null;
    if (!active.ok) {
      setStatus("error", active.error);
      emit();
    }
    return active;
  }

  function applyActiveData(
    data: ActiveSessionCommandData,
    preferredItemId?: string | null,
  ): boolean {
    if (!data.enabled || !data.origin) {
      applyUnsupportedActive();
      return true;
    }
    if (data.readback === null) {
      applyNoSession(data.origin, data.activePage);
      return true;
    }
    const rememberedItemId = preferredItemId === undefined
      ? data.selectedItemId ?? getRememberedPageSelection(data.activePage)
      : preferredItemId;
    return applyActive(
      data.readback,
      rememberedItemId,
      data.activePage,
      data.currentItemIds === undefined ? null : data.currentItemIds,
      readActiveMetadataDiagnostics(data),
    );
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
    currentItemIds: readonly string[] | null = snapshot.currentItemIds,
    metadataDiagnostics: unknown = null,
    recovery: PanelSessionSnapshot["recovery"] = null,
    recoveryMessage = "Resolve the unsaved intent before changing this session.",
  ): boolean {
    if (readback === null) {
      pendingClearOperationId = null;
      snapshot = {
        ...createEmptySnapshot(),
        viewMode: snapshot.viewMode,
        sessionMutationPending: activeMutations.size > 0,
      };
      stateRevision += 1;
      emit();
      return true;
    }
    const parsedReadback = parseAuthoritativeActiveSessionReadback(readback);
    if (parsedReadback === null) {
      setStatus("error", "Session clear status is invalid. Refresh and try again.");
      emit();
      return false;
    }
    const clearStatus = parseAuthoritativeClearStatus(parsedReadback);
    if (clearStatus === null) return false;
    if (clearStatus.clearPending) {
      pendingClearOperationId = clearStatus.activeClearOperationId;
    } else {
      pendingClearOperationId = null;
    }

    const file = cloneNullable(parsedReadback.file);
    const legacyRecord = cloneNullable(parsedReadback.legacyRecord);
    const selectedItemId = chooseSelectedItemId(file, preferredItemId, activePage);
    const selectedItem = findPanelSessionItem(file, selectedItemId);
    const validatedMetadataDiagnostics = validateBoundMetadataDiagnostics(
      metadataDiagnostics,
      file,
    );
    rememberPageSelection(activePage, selectedItemId);
    const hasSessionItems = (file?.session.attachments.length ?? 0) > 0;
    snapshot = {
      ...snapshot,
      activeSupported: true,
      activePage,
      clearPending: clearStatus.clearPending,
      activeClearOperationId: clearStatus.activeClearOperationId,
      sessionMutationPending: activeMutations.size > 0,
      origin: parsedReadback.origin,
      epoch: parsedReadback.epoch,
      file,
      legacyRecord,
      currentItemIds: currentItemIds === null ? null : [...currentItemIds],
      metadataDiagnostics: validatedMetadataDiagnostics,
      selectedItemId,
      intent: selectedItem?.sourceRecord.intent ?? "",
      intentDirty: false,
      recovery,
      status: recovery
        ? { kind: "error", message: recoveryMessage }
        : clearStatus.clearPending
        ? { kind: "saving", message: "A session clear is already in progress." }
        : hasSessionItems
          ? { kind: "ready", message: "Capture session ready." }
          : parsedReadback.legacyRecord
            ? { kind: "ready", message: "Selected element preview ready." }
            : {
                kind: "empty",
                message: "No session for this origin. Capture an element to start one.",
              },
    };
    stateRevision += 1;
    emit();
    return true;
  }

  function applyActiveWithRecovery(
    data: ActiveSessionCommandData,
    recovery: NonNullable<PanelSessionSnapshot["recovery"]>,
    message?: string,
  ): boolean {
    const readback = data.readback === null
      ? null
      : parseAuthoritativeActiveSessionReadback(data.readback);
    if (!data.enabled || data.origin !== recovery.oldOrigin ||
        readback?.origin !== recovery.oldOrigin || readback.epoch !== recovery.oldEpoch) {
      return false;
    }
    return applyActive(
      readback,
      snapshot.selectedItemId,
      data.activePage,
      data.currentItemIds === undefined ? null : data.currentItemIds,
      readActiveMetadataDiagnostics(data),
      recovery,
      message,
    );
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

  async function flushCurrentIntent(request: SnapshotRequest): Promise<boolean> {
    lastFlushBlockMessage = "";
    if (snapshot.recovery) {
      lastFlushBlockMessage = "Resolve the unsaved intent before changing this session.";
      setStatus("error", lastFlushBlockMessage);
      emit();
      return false;
    }

    if (!snapshot.intentDirty) return true;

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
    if (!isSnapshotRequestCurrent(request)) return false;
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

    if (!isSnapshotRequestCurrent(request)) return false;
    if (!applyActive(response.data, target.itemId) || snapshot.clearPending) return false;
    setStatus("success", "Intent saved.");
    emit();
    return true;
  }

  async function callClear(
    origin: string,
    epoch: string | null,
    operationId: string,
    scope?: PanelSessionClearScope,
  ): Promise<SessionCommandResponse<ActiveSessionReadback>> {
    try {
      return scope === undefined
        ? await options.client.clear(origin, epoch, operationId)
        : await options.client.clear(origin, epoch, operationId, scope);
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
    request: SnapshotRequest,
  ): Promise<void> {
    if (!isClearReconciliationCurrent(mutation, request)) return;

    let active: SessionCommandResponse<ActiveSessionCommandData>;
    try {
      active = await options.client.getActive();
    } catch {
      if (!isClearReconciliationCurrent(mutation, request)) return;
      pendingClearOperationId = stableOperationId;
      setStatus("error", SAFE_PANEL_ERROR);
      emit();
      return;
    }

    if (!isClearReconciliationCurrent(mutation, request)) return;
    if (!active.ok) {
      pendingClearOperationId = stableOperationId;
      setStatus("error", SAFE_PANEL_ERROR);
      emit();
      return;
    }

    if (
      !isClearReconciliationCurrent(mutation, request) ||
      !isActiveDataForMutationOrigin(active.data, mutation)
    ) {
      return;
    }

    if (!isClearReconciliationCurrent(mutation, request)) return;
    const applied = applyActiveData(active.data);
    if (!applied) {
      pendingClearOperationId = stableOperationId;
      return;
    }
    if (snapshot.clearPending) {
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
      const request = beginSnapshotRequest();
      const active = await loadActive(request);
      if (!active || !active.ok || !isSnapshotRequestCurrent(request)) return;
      applyActiveData(active.data);
    },

    async refreshActiveOrigin(preferredCaptureItemId) {
      const request = beginSnapshotRequest();
      cancelDebounce();
      const requestId = ++refreshRequestSequence;
      const startStateRevision = stateRevision;
      const startActivePage = snapshot.activePage;

      if (snapshot.recovery) {
        const recovery = snapshot.recovery;
        const active = await options.client.getActive();
        if (!isSnapshotRequestCurrent(request) || requestId !== refreshRequestSequence ||
            stateRevision !== startStateRevision) return;
        if (active.ok && applyActiveWithRecovery(active.data, recovery)) return;
        setStatus("error", active.ok
          ? "Resolve the unsaved intent before changing this session."
          : active.error);
        emit();
        return;
      }

      if (snapshot.intentDirty) {
        const oldTarget = getCurrentMutationTarget();
        const capturedIntent = snapshot.intent;
        const capturedRevision = intentRevision;
        const active = await options.client.getActive();
        if (!isSnapshotRequestCurrent(request)) return;
        if (requestId !== refreshRequestSequence) return;
        if (stateRevision !== startStateRevision) return;
        if (!active.ok) {
          setStatus("error", active.error);
          emit();
          return;
        }
        const activeCaptureItemId = getActiveCaptureItemId(active.data, preferredCaptureItemId);
        if (!oldTarget) return;
        const recovery = {
          oldOrigin: oldTarget.origin,
          oldEpoch: oldTarget.epoch,
          itemId: oldTarget.itemId,
          intent: capturedIntent,
          pendingOrigin: active.data.origin,
        };
        const readback = active.data.readback === null
          ? null
          : parseAuthoritativeActiveSessionReadback(active.data.readback);
        if (readback?.origin === oldTarget.origin && readback.epoch === oldTarget.epoch &&
            !findPanelSessionItem(readback.file, oldTarget.itemId) &&
            applyActiveWithRecovery(active.data, recovery)) return;
        const response = await options.client.updateIntent(
          oldTarget.origin,
          oldTarget.epoch,
          oldTarget.itemId,
          capturedIntent,
        );
        if (!isSnapshotRequestCurrent(request)) return;
        if (requestId !== refreshRequestSequence) return;
        if (!isStillCurrentIntentTarget(oldTarget, capturedIntent, capturedRevision)) return;
        if (!response.ok) {
          if (applyActiveWithRecovery(active.data, recovery, response.error)) return;
          snapshot = {
            ...snapshot,
            recovery,
            status: { kind: "error", message: response.error },
          };
          stateRevision += 1;
          emit();
          return;
        }
        if (stateRevision !== startStateRevision) return;
        if (!isSnapshotRequestCurrent(request)) return;
        const activeOrigin = active.data.origin ?? getAuthoritativeReadbackOrigin(active.data.readback);
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
      if (!isSnapshotRequestCurrent(request)) return;
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
      if (!isSnapshotRequestCurrent(request)) return;
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
      const currentItem = findPanelSessionItem(snapshot.file, itemId);
      if (!currentItem || (currentItem.id === snapshot.selectedItemId && !snapshot.intentDirty)) {
        return;
      }
      const request = beginSnapshotRequest();
      if (!(await flushCurrentIntent(request))) return;
      if (!isSnapshotRequestCurrent(request)) return;
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
      if (intent === snapshot.intent) return;
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
        void flushCurrentIntent(beginSnapshotRequest());
      }, DEBOUNCE_MS);
      emit();
    },

    flushIntent() {
      if (snapshot.recovery) {
        lastFlushBlockMessage = "Resolve the unsaved intent before changing this session.";
        setStatus("error", lastFlushBlockMessage);
        emit();
        return Promise.resolve(false);
      }
      if (!snapshot.intentDirty) return Promise.resolve(true);
      return flushCurrentIntent(beginSnapshotRequest());
    },

    async retryDirtyIntent() {
      const recovery = snapshot.recovery;
      if (!recovery) {
        if (!snapshot.intentDirty) return;
        const request = beginSnapshotRequest();
        await flushCurrentIntent(request);
        return;
      }
      const request = beginSnapshotRequest();
      setStatus("saving", "Saving recovered intent.");
      emit();
      const response = await options.client.updateIntent(
        recovery.oldOrigin,
        recovery.oldEpoch,
        recovery.itemId,
        recovery.intent,
      );
      if (!isSnapshotRequestCurrent(request)) return;
      if (!response.ok) {
        setStatus("error", response.error);
        emit();
        return;
      }

      snapshot = { ...snapshot, recovery: null, intentDirty: false };
      stateRevision += 1;
      if (recovery.pendingOrigin) {
        const active = await loadActive(request);
        if (active?.ok && isSnapshotRequestCurrent(request)) {
          applyActiveData(active.data);
        }
        return;
      }
      if (!isSnapshotRequestCurrent(request)) return;
      applyActive(response.data, recovery.itemId);
    },

    async discardDirtyIntent() {
      if (!snapshot.recovery && !snapshot.intentDirty) return;
      cancelDebounce();
      const request = beginSnapshotRequest();
      if (snapshot.recovery) {
        const recovery = snapshot.recovery;
        if (!snapshot.intentDirty && snapshot.origin === recovery.oldOrigin &&
            snapshot.epoch === recovery.oldEpoch && snapshot.origin === recovery.pendingOrigin) {
          // This draft is already separate from the authoritative selection.
          // Discard only local text; another refresh must not cancel that choice.
          snapshot = {
            ...snapshot,
            recovery: null,
            status: snapshot.file?.session.attachments.length
              ? { kind: "ready", message: "Capture session ready." }
              : { kind: "empty", message: "No session for this origin. Capture an element to start one." },
          };
          stateRevision += 1;
          emit();
          return;
        }
        const active = await loadActive(request);
        if (!active || !isSnapshotRequestCurrent(request)) return;
        const activeOrigin = active.ok
          ? active.data.origin ?? getAuthoritativeReadbackOrigin(active.data.readback)
          : null;
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

    async setAnnotationLifecycle(itemId, nextState) {
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
      const currentItem = findPanelSessionItem(snapshot.file, itemId);
      if (!currentItem || !("annotationId" in currentItem) ||
          typeof currentItem.annotationId !== "string") {
        setStatus("error", "Annotation identity is unavailable. Refresh and try again.");
        emit();
        return;
      }
      const expectedState: CaptureSessionAnnotationLifecycleStateV3 =
        "annotationLifecycle" in currentItem
          ? currentItem.annotationLifecycle.state
          : "open";
      if (expectedState === nextState) return;
      const request = beginSnapshotRequest();
      if (!(await flushCurrentIntent(request))) return;
      if (!isSnapshotRequestCurrent(request)) return;
      const target = getCurrentMutationTarget();
      if (!target) return;
      const mutation = beginMutation(
        nextState === "resolved" ? "Resolving annotation." : "Reopening annotation.",
        target,
      );
      const response = await options.client.updateAnnotationLifecycle(
        target.origin,
        target.epoch,
        itemId,
        currentItem.annotationId,
        expectedState,
        nextState,
      );
      const current = isMutationCurrent(mutation, request);
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
      const readback = parseAuthoritativeActiveSessionReadback(response.data);
      const updatedItem = readback?.file && findPanelSessionItem(readback.file, itemId);
      const exactLifecycle = updatedItem && "annotationId" in updatedItem &&
        updatedItem.annotationId === currentItem.annotationId &&
        "annotationLifecycle" in updatedItem &&
        updatedItem.annotationLifecycle.state === nextState &&
        (nextState === "resolved"
          ? updatedItem.annotationLifecycle.resolvedAt === updatedItem.updatedAt
          : updatedItem.annotationLifecycle.resolvedAt === null);
      if (!readback || !exactLifecycle) {
        setStatus("error", "Annotation state was not updated. Refresh and try again.");
        emit();
        return;
      }
      if (!isSnapshotRequestCurrent(request)) return;
      if (!applyActive(readback, itemId) || snapshot.clearPending) return;
      setStatus(
        "success",
        nextState === "resolved" ? "Annotation resolved." : "Annotation reopened.",
      );
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
      if (!findPanelSessionItem(snapshot.file, itemId)) return;
      const request = beginSnapshotRequest();
      if (!(await flushCurrentIntent(request))) return;
      if (!isSnapshotRequestCurrent(request)) return;
      const target = getCurrentMutationTarget();
      if (!target) return;
      const preferred = choosePostRemoveSelection(snapshot.file, snapshot.selectedItemId, itemId);
      const mutation = beginMutation("Removing session item.", target);
      const response = await options.client.removeItem(target.origin, target.epoch, itemId);
      const current = isMutationCurrent(mutation, request);
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
      const readback = parseAuthoritativeActiveSessionReadback(response.data);
      if (readback === null) {
        setStatus("error", "Session clear status is invalid. Refresh and try again.");
        emit();
        return;
      }
      if (findPanelSessionItem(readback.file, itemId)) {
        setStatus("error", "Session item was not removed. Refresh and try again.");
        emit();
        return;
      }
      if (!isSnapshotRequestCurrent(request)) return;
      if (!applyActive(readback, preferred) || snapshot.clearPending) return;
      setStatus("success", "Session item removed.");
      emit();
    },

    async clearSession(operationId, scope) {
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
      if (!isDurableClearOperationId(operationId)) {
        setStatus("error", "Clear operation ID is invalid. Refresh and try again.");
        emit();
        return;
      }
      const request = beginSnapshotRequest();
      pendingClearOperationId = pendingClearOperationId ?? operationId;
      const stableOperationId = pendingClearOperationId;
      const target = { origin: snapshot.origin, epoch: snapshot.epoch };
      const mutation = beginMutation("Clearing capture session.", target);
      const response = await callClear(snapshot.origin, snapshot.epoch, stableOperationId, scope);
      const current = isMutationCurrent(mutation, request);
      const pendingChanged = finishMutation(mutation);
      if (!current) {
        if (pendingChanged) emit();
        return;
      }
      if (!response.ok) {
        await reconcileClearFailure(response.error, stableOperationId, mutation, request);
        return;
      }
      if (!isSnapshotRequestCurrent(request)) return;
      if (!applyActive(response.data)) return;
      if (snapshot.clearPending) return;
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
      const request = beginSnapshotRequest();
      if (!(await flushCurrentIntent(request))) {
        return invalidExport(lastFlushBlockMessage || snapshot.status.message);
      }
      if (!isSnapshotRequestCurrent(request)) {
        return invalidExport("Panel state changed before export. Save again and retry.");
      }
      if (activeMutations.size > 0) {
        return invalidExport("Session mutation is still in progress. Try again after it finishes.");
      }
      const exportStateRevision = stateRevision;
      const renderedOrigin = snapshot.origin;
      const renderedEpoch = snapshot.epoch;
      const active = await options.client.getActive();
      if (!isSnapshotRequestCurrent(request) || stateRevision !== exportStateRevision) {
        return invalidExport("Panel state changed before export. Save again and retry.");
      }
      if (!active.ok) return invalidExport(active.error);
      const readback = active.data.readback === null
        ? null
        : parseAuthoritativeActiveSessionReadback(active.data.readback);
      if (!readback || !readback.file) {
        return invalidExport(active.data.readback === null
          ? "No active capture session to export."
          : "Session clear status is invalid. Refresh the panel and try again.");
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
      if (!isSnapshotRequestCurrent(request)) {
        return invalidExport("Panel state changed before export. Save again and retry.");
      }
      if (!applyActive(
        readback,
        snapshot.selectedItemId,
        snapshot.activePage,
        snapshot.currentItemIds,
        readActiveMetadataDiagnostics(active.data),
      )) {
        return invalidExport("Session clear status is invalid. Refresh the panel and try again.");
      }
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
    activeClearOperationId: null,
    sessionMutationPending: false,
    origin: null,
    epoch: null,
    file: null,
    legacyRecord: null,
    currentItemIds: null,
    metadataDiagnostics: null,
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

type AuthoritativeClearStatus =
  | { clearPending: false; activeClearOperationId: null }
  | { clearPending: true; activeClearOperationId: string };

const ACTIVE_SESSION_READBACK_KEYS: readonly string[] = [
  "origin",
  "epoch",
  "clearPending",
  "activeClearOperationId",
  "file",
  "legacyRecord",
];

function parseAuthoritativeClearStatus(
  readback: unknown,
): AuthoritativeClearStatus | null {
  const fields = readExactOwnDataProperties(readback, ACTIVE_SESSION_READBACK_KEYS);
  return fields === null ? null : parseClearStatusFields(fields);
}

function parseAuthoritativeActiveSessionReadback(
  readback: unknown,
): ActiveSessionReadback | null {
  const fields = readExactOwnDataProperties(readback, ACTIVE_SESSION_READBACK_KEYS);
  if (fields === null) return null;
  const clearStatus = parseClearStatusFields(fields);
  if (clearStatus === null) return null;
  return {
    origin: fields.origin as ActiveSessionReadback["origin"],
    epoch: fields.epoch as ActiveSessionReadback["epoch"],
    clearPending: clearStatus.clearPending,
    activeClearOperationId: clearStatus.activeClearOperationId,
    file: fields.file as CaptureSessionFile | null,
    legacyRecord: fields.legacyRecord as OriginCaptureRecord | null,
  };
}

function parseClearStatusFields(fields: Record<string, unknown>): AuthoritativeClearStatus | null {
  if (fields.clearPending === false && fields.activeClearOperationId === null) {
    return { clearPending: false, activeClearOperationId: null };
  }
  return fields.clearPending === true && isDurableClearOperationId(fields.activeClearOperationId)
    ? { clearPending: true, activeClearOperationId: fields.activeClearOperationId }
    : null;
}

function getAuthoritativeReadbackOrigin(readback: ActiveSessionReadback | null): string | null {
  return readback === null ? null : parseAuthoritativeActiveSessionReadback(readback)?.origin ?? null;
}

function readExactOwnDataProperties(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return null;
    }
    const fields: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
  }
}

function isDurableClearOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/\p{Cc}/u.test(value);
}

function chooseSelectedItemId(
  file: CaptureSessionFile | null,
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
  file: CaptureSessionFile | null,
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
  if (!preferredCaptureItemId || !data.activePage || data.readback === null) return undefined;
  const readback = parseAuthoritativeActiveSessionReadback(data.readback);
  if (!readback?.file) return undefined;
  const item = findPanelSessionItem(readback.file, preferredCaptureItemId);
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
  file: CaptureSessionFile;
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
    currentItemIds: snapshot.currentItemIds === null ? null : [...snapshot.currentItemIds],
    metadataDiagnostics: cloneNullable(snapshot.metadataDiagnostics),
    status: { ...snapshot.status },
    recovery: snapshot.recovery ? { ...snapshot.recovery } : null,
  };
}

function readActiveMetadataDiagnostics(data: ActiveSessionCommandData): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(data, "metadataDiagnostics");
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function validateBoundMetadataDiagnostics(
  value: unknown,
  file: CaptureSessionFile | null,
): MetadataDiagnosticsV1 | null {
  if (!file || value === null || value === undefined) return null;
  const validation = validateMetadataDiagnosticsV1(value);
  if (!validation.ok) return null;
  const diagnostics = validation.value;
  return diagnostics.captureId === file.session.id &&
      diagnostics.authority === "capture_time" &&
      diagnostics.consent === "explicit_capture" &&
      diagnostics.observedAt <= file.session.updatedAt &&
      diagnostics.network.status === "not_requested" &&
      diagnostics.console.status === "not_requested"
    ? diagnostics
    : null;
}

function cloneNullable<T>(value: T | null): T | null {
  return value === null ? null : structuredClone(value);
}
