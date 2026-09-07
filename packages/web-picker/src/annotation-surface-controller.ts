import type { AttachmentFeedbackDetail } from "@meanthis/prompt";
import {
  sanitizeClearStatus,
  type ClearStatus,
  type InPageWidgetBusyAction,
  type InPageWidgetMode,
  type InPageWidgetStatusViewModel,
} from "./in-page-widget-view.js";

const CLEAR_CONFIRMATION_WINDOW_MS = 4_000;
const MAX_ANNOTATIONS = 26;

export type AnnotationSurfaceReadiness = "hydrating" | "ready" | "error";

export type AnnotationLifecycleState = "open" | "resolved";

export interface AnnotationLifecycle {
  state: AnnotationLifecycleState;
  resolvedAt: string | null;
}

export interface AnnotationSurfaceItem {
  itemId: string;
  label: string;
  name: string;
  taskNote: string;
  /** Null means this is a legacy/non-actionable annotation. */
  annotationLifecycle?: AnnotationLifecycle | null;
}

export interface AnnotationSurfaceReadback {
  items: readonly AnnotationSurfaceItem[];
  activeItemId: string | null;
  clearStatus?: ClearStatus;
}

export interface AnnotationSurfaceCopyResult {
  text: string;
  count: number;
  copied: boolean;
  readback?: AnnotationSurfaceReadback;
}

/**
 * Environment port for the shared annotation behavior state machine.
 *
 * SDK integrations normally implement this with page-owned memory. MV3 uses
 * authenticated extension commands and durable session readbacks. Every
 * mutation returns the authoritative post-action state so the shared
 * controller never treats a transport acknowledgement as product success.
 */
export interface AnnotationSurfaceAdapter {
  activate(itemId: string): Promise<AnnotationSurfaceReadback>;
  stageTaskNote(itemId: string, note: string): void;
  saveTaskNote(itemId: string, note: string): Promise<AnnotationSurfaceReadback>;
  setAnnotationLifecycle?(
    itemId: string,
    nextState: AnnotationLifecycleState,
  ): Promise<AnnotationSurfaceReadback>;
  remove(itemId: string): Promise<AnnotationSurfaceReadback>;
  clear(operationId?: string): Promise<AnnotationSurfaceReadback>;
  copy(detail: AttachmentFeedbackDetail): Promise<AnnotationSurfaceCopyResult>;
}

export interface AnnotationSurfaceStrings {
  taskNoteSaved: string;
  annotationResolved: string;
  annotationReopened: string;
  annotationLifecycleUnconfirmed: string;
  annotationRemoved: string;
  annotationRemoveUnconfirmed: string;
  annotationsCleared: string;
  annotationsClearPending: string;
  annotationsClearUnconfirmed: string;
  copySucceeded(count: number): string;
  copyFailed: string;
  operationFailed: string;
}

export interface AnnotationSurfaceSnapshot extends AnnotationSurfaceReadback {
  clearStatus: ClearStatus;
  readiness: AnnotationSurfaceReadiness;
  mode: InPageWidgetMode;
  taskNote: string;
  outputDetail: AttachmentFeedbackDetail;
  busyAction: InPageWidgetBusyAction;
  clearConfirmationRequired: boolean;
  manualCopyText: string | null;
  status: InPageWidgetStatusViewModel | null;
}

export interface AnnotationSurfaceControllerOptions {
  adapter: AnnotationSurfaceAdapter;
  initialMode?: InPageWidgetMode;
  initialOutputDetail?: AttachmentFeedbackDetail;
  initialReadiness?: AnnotationSurfaceReadiness;
  strings?: Partial<AnnotationSurfaceStrings>;
  beforeClear?(): void | Promise<void>;
  setTimeout?(callback: () => void, delay: number): unknown;
  clearTimeout?(id: unknown): void;
  onChange?(snapshot: AnnotationSurfaceSnapshot): void;
}

export interface AnnotationSurfaceController {
  getSnapshot(): AnnotationSurfaceSnapshot;
  applyReadback(readback: AnnotationSurfaceReadback): void;
  setReadiness(readiness: AnnotationSurfaceReadiness): void;
  setMode(mode: InPageWidgetMode): void;
  setOutputDetail(detail: AttachmentFeedbackDetail): void;
  setStatus(status: InPageWidgetStatusViewModel | null): void;
  setBusyAction(action: InPageWidgetBusyAction): void;
  setManualCopyText(text: string | null): void;
  activate(itemId: string): Promise<boolean>;
  edit(itemId: string): Promise<boolean>;
  more(itemId: string): Promise<boolean>;
  closeEditor(): void;
  setTaskNote(itemId: string, note: string): boolean;
  save(itemId: string): Promise<boolean>;
  saveInline(itemId: string, note: string): Promise<boolean>;
  setAnnotationLifecycle(itemId: string, nextState: AnnotationLifecycleState): Promise<boolean>;
  remove(itemId: string): Promise<boolean>;
  requestClear(): Promise<boolean>;
  clearNow(): Promise<boolean>;
  cancelPendingAction(): void;
  disarmClearConfirmation(): void;
  copy(): Promise<string | null>;
  dispose(): void;
}

const DEFAULT_STRINGS: AnnotationSurfaceStrings = {
  taskNoteSaved: "Task note saved.",
  annotationResolved: "Annotation resolved.",
  annotationReopened: "Annotation reopened.",
  annotationLifecycleUnconfirmed: "Annotation state was not updated. Refresh and try again.",
  annotationRemoved: "Annotation removed.",
  annotationRemoveUnconfirmed: "Annotation was not removed. Refresh and try again.",
  annotationsCleared: "Annotations cleared.",
  annotationsClearPending: "Clearing page annotations is still pending. Retry to confirm completion.",
  annotationsClearUnconfirmed: "Annotations were not cleared. Refresh and try again.",
  copySucceeded: (count) => `Copied ${count} annotation${count === 1 ? "" : "s"}.`,
  copyFailed: "Copy was blocked. Copy the text manually.",
  operationFailed: "MeanThis action failed. Try again.",
};

export function createAnnotationSurfaceController(
  options: AnnotationSurfaceControllerOptions,
): AnnotationSurfaceController {
  const strings: AnnotationSurfaceStrings = { ...DEFAULT_STRINGS, ...options.strings };
  const schedule = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id as number));
  let snapshot: AnnotationSurfaceSnapshot = {
    readiness: options.initialReadiness ?? "hydrating",
    mode: options.initialMode ?? "collapsed",
    items: [],
    activeItemId: null,
    clearStatus: { clearState: "idle", operationId: null },
    taskNote: "",
    outputDetail: options.initialOutputDetail ?? "compact",
    busyAction: null,
    clearConfirmationRequired: false,
    manualCopyText: null,
    status: null,
  };
  let clearTimer: unknown = null;
  let actionPending = false;
  let actionRevision = 0;
  let disposed = false;

  function emit(): void {
    if (!disposed) options.onChange?.(cloneSnapshot(snapshot));
  }

  function update(patch: Partial<AnnotationSurfaceSnapshot>): void {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    emit();
  }

  function isReadyForItem(itemId: string): boolean {
    return !disposed && !actionPending && snapshot.readiness === "ready" &&
      snapshot.items.some((item) => item.itemId === itemId);
  }

  function isCurrentAction(revision: number): boolean {
    return !disposed && actionPending && revision === actionRevision;
  }

  function applyReadback(readback: AnnotationSurfaceReadback): void {
    if (disposed) return;
    const items = readback.items.slice(0, MAX_ANNOTATIONS).map((item) => ({
      ...item,
      annotationLifecycle: sanitizeAnnotationLifecycle(item.annotationLifecycle),
    }));
    const activeItemId = readback.activeItemId &&
        items.some((item) => item.itemId === readback.activeItemId)
      ? readback.activeItemId
      : items.some((item) => item.itemId === snapshot.activeItemId)
        ? snapshot.activeItemId
        : items[0]?.itemId ?? null;
    const active = items.find((item) => item.itemId === activeItemId) ?? null;
    const clearStatus = sanitizeClearStatus(readback.clearStatus);
    let mode = snapshot.mode;
    if (mode === "editing" && active === null) mode = items.length > 0 ? "details" : "ready";
    snapshot = {
      ...snapshot,
      items,
      activeItemId,
      clearStatus,
      taskNote: active?.taskNote ?? "",
      mode,
    };
    emit();
  }

  async function activate(itemId: string): Promise<boolean> {
    if (!isReadyForItem(itemId)) return false;
    const revision = ++actionRevision;
    actionPending = true;
    update({ status: null });
    if (!isCurrentAction(revision)) return false;
    try {
      const readback = await options.adapter.activate(itemId);
      if (!isCurrentAction(revision)) return false;
      if (!readback.items.some((item) => item.itemId === itemId)) {
        throw new Error(strings.operationFailed);
      }
      applyReadback({ ...readback, activeItemId: itemId });
      if (!isCurrentAction(revision)) return false;
      return true;
    } catch (error) {
      if (!isCurrentAction(revision)) return false;
      update({ status: errorStatus(error, strings.operationFailed) });
      return false;
    } finally {
      if (isCurrentAction(revision)) actionPending = false;
    }
  }

  async function edit(itemId: string): Promise<boolean> {
    if (!await activate(itemId)) return false;
    update({ mode: "editing" });
    return true;
  }

  async function more(itemId: string): Promise<boolean> {
    if (!await activate(itemId)) return false;
    update({ mode: "details" });
    return true;
  }

  function setTaskNote(itemId: string, note: string): boolean {
    if (!isReadyForItem(itemId) || snapshot.activeItemId !== itemId) return false;
    try {
      options.adapter.stageTaskNote(itemId, note);
      update({
        taskNote: note,
        items: snapshot.items.map((item) => item.itemId === itemId
          ? { ...item, taskNote: note }
          : item),
      });
      return true;
    } catch (error) {
      update({ status: errorStatus(error, strings.operationFailed) });
      return false;
    }
  }

  async function save(itemId: string): Promise<boolean> {
    if (!isReadyForItem(itemId) || snapshot.activeItemId !== itemId) return false;
    const note = snapshot.taskNote;
    return runMutation("save", async (isCurrent) => {
      const readback = await options.adapter.saveTaskNote(itemId, note);
      if (!isCurrent()) return;
      const saved = readback.items.find((item) => item.itemId === itemId);
      if (!saved || saved.taskNote !== note) throw new Error(strings.operationFailed);
      applyReadback({ ...readback, activeItemId: itemId });
      if (!isCurrent()) return;
      update({ mode: "details", status: { kind: "success", message: strings.taskNoteSaved } });
    });
  }

  async function saveInline(itemId: string, note: string): Promise<boolean> {
    if (!isReadyForItem(itemId)) return false;
    // Inline marker editing is transient: it must not steal the durable panel
    // selection when its marker is not the currently active annotation.
    const activeItemId = snapshot.activeItemId;
    const mode = snapshot.mode;
    return runMutation("save", async (isCurrent) => {
      const readback = await options.adapter.saveTaskNote(itemId, note);
      if (!isCurrent()) return;
      const saved = readback.items.find((item) => item.itemId === itemId);
      if (!saved || saved.taskNote !== note) throw new Error(strings.operationFailed);
      applyReadback({ ...readback, activeItemId });
      if (!isCurrent()) return;
      update({ mode, status: { kind: "success", message: strings.taskNoteSaved } });
    });
  }

  async function setAnnotationLifecycle(
    itemId: string,
    nextState: AnnotationLifecycleState,
  ): Promise<boolean> {
    if (!isAnnotationLifecycleState(nextState) || !isReadyForItem(itemId)) return false;
    const currentItem = snapshot.items.find((item) => item.itemId === itemId);
    const currentLifecycle = sanitizeAnnotationLifecycle(currentItem?.annotationLifecycle);
    const mutate = options.adapter.setAnnotationLifecycle;
    if (!currentLifecycle || currentLifecycle.state === nextState || typeof mutate !== "function") {
      return false;
    }
    return runMutation("lifecycle", async (isCurrent) => {
      const readback = await mutate(itemId, nextState);
      if (!isCurrent()) return;
      const updated = readback.items.find((item) => item.itemId === itemId);
      const updatedLifecycle = sanitizeAnnotationLifecycle(updated?.annotationLifecycle);
      if (!updated || !updatedLifecycle || !isExactAnnotationLifecycleState(updatedLifecycle, nextState)) {
        throw new Error(strings.annotationLifecycleUnconfirmed);
      }
      applyReadback({ ...readback, activeItemId: itemId });
      if (!isCurrent()) return;
      update({
        status: {
          kind: "success",
          message: nextState === "resolved"
            ? strings.annotationResolved
            : strings.annotationReopened,
        },
      });
    });
  }

  async function remove(itemId: string): Promise<boolean> {
    if (!isReadyForItem(itemId)) return false;
    return runMutation("remove", async (isCurrent) => {
      const readback = await options.adapter.remove(itemId);
      if (!isCurrent()) return;
      if (readback.items.some((item) => item.itemId === itemId)) {
        throw new Error(strings.annotationRemoveUnconfirmed);
      }
      applyReadback(readback);
      if (!isCurrent()) return;
      update({
        mode: readback.items.length === 0 ? "ready" : snapshot.mode === "editing" ? "details" : snapshot.mode,
        status: { kind: "success", message: strings.annotationRemoved },
      });
    });
  }

  async function requestClear(): Promise<boolean> {
    if (disposed || actionPending || snapshot.readiness !== "ready" ||
        (snapshot.items.length === 0 && snapshot.clearStatus.clearState === "idle")) {
      return false;
    }
    if (snapshot.clearStatus.clearState === "pending") return clearNow();
    if (!snapshot.clearConfirmationRequired) {
      armClearConfirmation();
      update({ status: null });
      return false;
    }
    return clearNow();
  }

  async function clearNow(): Promise<boolean> {
    if (disposed || actionPending || snapshot.readiness !== "ready" ||
        (snapshot.items.length === 0 && snapshot.clearStatus.clearState === "idle")) {
      return false;
    }
    disarmClearConfirmation();
    const operationId = snapshot.clearStatus.clearState === "pending"
      ? snapshot.clearStatus.operationId
      : undefined;
    let stillPending = false;
    const completed = await runMutation("clear", async (isCurrent) => {
      const beforeClear = options.beforeClear?.();
      if (beforeClear !== undefined) await beforeClear;
      if (!isCurrent()) return;
      const readback = await options.adapter.clear(operationId);
      if (!isCurrent()) return;
      const clearStatus = sanitizeClearStatus(readback.clearStatus);
      if (clearStatus.clearState === "pending") {
        applyReadback(readback);
        if (!isCurrent()) return;
        stillPending = true;
        update({
          status: { kind: "info", message: strings.annotationsClearPending },
        });
        return;
      }
      if (readback.items.length !== 0) throw new Error(strings.annotationsClearUnconfirmed);
      applyReadback(readback);
      if (!isCurrent()) return;
      update({
        mode: "ready",
        status: { kind: "success", message: strings.annotationsCleared },
      });
    });
    return completed && !stillPending;
  }

  async function copy(): Promise<string | null> {
    if (disposed || actionPending || snapshot.readiness !== "ready" || snapshot.items.length === 0) {
      return null;
    }
    let text: string | null = null;
    const ok = await runMutation("copy", async (isCurrent) => {
      const result = await options.adapter.copy(snapshot.outputDetail);
      if (!isCurrent()) return;
      text = result.text;
      if (result.readback) {
        applyReadback(result.readback);
        if (!isCurrent()) return;
      }
      update(result.copied
        ? {
            manualCopyText: null,
            status: { kind: "success", message: strings.copySucceeded(result.count) },
          }
        : {
            manualCopyText: result.text,
            status: { kind: "error", message: strings.copyFailed },
          });
    });
    return ok ? text : null;
  }

  async function runMutation(
    action: Exclude<InPageWidgetBusyAction, null | "disclosure" | "connect" | "refresh" |
      "disconnect" | "frame-scope">,
    mutation: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<boolean> {
    if (disposed || actionPending) return false;
    const revision = ++actionRevision;
    actionPending = true;
    update({ busyAction: action, status: null });
    try {
      if (!isCurrentAction(revision)) return false;
      await mutation(() => isCurrentAction(revision));
      return isCurrentAction(revision);
    } catch (error) {
      if (!isCurrentAction(revision)) return false;
      update({ status: errorStatus(error, strings.operationFailed) });
      return false;
    } finally {
      if (isCurrentAction(revision)) {
        actionPending = false;
        update({ busyAction: null });
      }
    }
  }

  function cancelPendingAction(): void {
    if (disposed) return;
    actionRevision += 1;
    actionPending = false;
    if (snapshot.busyAction !== null) update({ busyAction: null });
  }

  function armClearConfirmation(): void {
    disarmClearConfirmation();
    snapshot = { ...snapshot, clearConfirmationRequired: true };
    clearTimer = schedule(() => {
      clearTimer = null;
      if (disposed || !snapshot.clearConfirmationRequired) return;
      update({ clearConfirmationRequired: false });
    }, CLEAR_CONFIRMATION_WINDOW_MS);
  }

  function disarmClearConfirmation(): void {
    if (clearTimer !== null) cancel(clearTimer);
    clearTimer = null;
    if (!snapshot.clearConfirmationRequired) return;
    update({ clearConfirmationRequired: false });
  }

  const controller: AnnotationSurfaceController = {
    getSnapshot: () => cloneSnapshot(snapshot),
    applyReadback,
    setReadiness(readiness): void {
      update({ readiness });
    },
    setMode(mode): void {
      if (mode === "editing" && snapshot.activeItemId === null) mode = "ready";
      if (mode !== "details" && mode !== "editing") disarmClearConfirmation();
      update({ mode });
    },
    setOutputDetail(outputDetail): void {
      update({ outputDetail, manualCopyText: null, status: null });
    },
    setStatus(status): void {
      update({ status });
    },
    setBusyAction(busyAction): void {
      update({ busyAction });
    },
    setManualCopyText(manualCopyText): void {
      update({ manualCopyText });
    },
    activate,
    edit,
    more,
    closeEditor(): void {
      update({ mode: "details" });
    },
    setTaskNote,
    save,
    saveInline,
    setAnnotationLifecycle,
    remove,
    requestClear,
    clearNow,
    cancelPendingAction,
    disarmClearConfirmation,
    copy,
    dispose(): void {
      if (disposed) return;
      if (clearTimer !== null) cancel(clearTimer);
      clearTimer = null;
      actionRevision += 1;
      actionPending = false;
      disposed = true;
    },
  };

  emit();
  return controller;
}

export function formatAnnotationLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_ANNOTATIONS) {
    throw new RangeError(`Annotation index must be between 0 and ${MAX_ANNOTATIONS - 1}.`);
  }
  return String(index + 1);
}

function cloneSnapshot(snapshot: AnnotationSurfaceSnapshot): AnnotationSurfaceSnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => ({
      ...item,
      annotationLifecycle: item.annotationLifecycle
        ? { ...item.annotationLifecycle }
        : null,
    })),
    clearStatus: { ...snapshot.clearStatus },
    status: snapshot.status ? { ...snapshot.status } : null,
  };
}

function isAnnotationLifecycleState(value: unknown): value is AnnotationLifecycleState {
  return value === "open" || value === "resolved";
}

function sanitizeAnnotationLifecycle(value: unknown): AnnotationLifecycle | null {
  if (!isRecord(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => (
      typeof key !== "string" || (key !== "state" && key !== "resolvedAt")
    ))) return null;
    const stateDescriptor = Reflect.getOwnPropertyDescriptor(value, "state");
    const resolvedAtDescriptor = Reflect.getOwnPropertyDescriptor(value, "resolvedAt");
    if (!stateDescriptor || stateDescriptor.enumerable !== true || !("value" in stateDescriptor) ||
        !resolvedAtDescriptor || resolvedAtDescriptor.enumerable !== true ||
        !("value" in resolvedAtDescriptor)) return null;
    const state = stateDescriptor.value;
    const resolvedAt = resolvedAtDescriptor.value;
    if (!isAnnotationLifecycleState(state)) return null;
    if (state === "open") {
      return resolvedAt === null ? { state, resolvedAt: null } : null;
    }
    return typeof resolvedAt === "string" && isCanonicalIsoDate(resolvedAt)
      ? { state, resolvedAt }
      : null;
  } catch {
    return null;
  }
}

function isExactAnnotationLifecycleState(
  lifecycle: AnnotationLifecycle,
  expectedState: AnnotationLifecycleState,
): boolean {
  return lifecycle.state === expectedState && (
    expectedState === "open"
      ? lifecycle.resolvedAt === null
      : lifecycle.resolvedAt !== null
  );
}

function isCanonicalIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorStatus(error: unknown, fallback: string): InPageWidgetStatusViewModel {
  return {
    kind: "error",
    message: error instanceof Error && error.message.trim().length > 0 ? error.message : fallback,
  };
}
