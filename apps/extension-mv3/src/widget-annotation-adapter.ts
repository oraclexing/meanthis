import type { AttachmentFeedbackDetail } from "@meanthis/prompt";
import type {
  AnnotationSurfaceAdapter,
  AnnotationSurfaceCopyResult,
  AnnotationSurfaceReadback,
} from "@meanthis/web-picker";
import type { PanelSessionController, PanelSessionSnapshot } from "./panel-session-controller";
import {
  derivePanelCurrentScope,
  findPanelSessionItem,
  getPanelSessionAnnotationLabels,
  summarizePanelSessionRows,
} from "./panel-session-model";

type PanelClearStatus =
  | { clearState: "idle"; operationId: null }
  | { clearState: "pending"; operationId: string };

type PanelAnnotationSurfaceReadback = AnnotationSurfaceReadback & {
  clearStatus: PanelClearStatus;
};

const PANEL_SESSION_SNAPSHOT_KEYS: readonly string[] = [
  "activeSupported",
  "activePage",
  "clearPending",
  "activeClearOperationId",
  "sessionMutationPending",
  "origin",
  "epoch",
  "file",
  "legacyRecord",
  "currentItemIds",
  "selectedItemId",
  "viewMode",
  "intent",
  "intentDirty",
  "status",
  "recovery",
  "metadataDiagnostics",
];

export interface CreatePanelAnnotationSurfaceAdapterOptions {
  controller: PanelSessionController;
  getCurrentScopeItemIds?(): readonly string[] | null;
  getCurrentScopeKind?(): "page" | "site";
  getCurrentPageItemIds?(): readonly string[] | null;
  activateOverlay(itemId: string): Promise<void>;
  copy(
    detail: AttachmentFeedbackDetail,
    snapshot: PanelSessionSnapshot,
  ): Promise<AnnotationSurfaceCopyResult>;
  createOperationId(): string;
  strings: {
    operationFailed: string;
    sessionNotReady: string;
    taskNoteSaveFailed: string;
  };
}

/**
 * Adapts the authenticated MV3 session controller to the shared annotation
 * behavior contract. The adapter owns transport and durable readback only;
 * edit/remove/more/clear UI transitions stay in @meanthis/web-picker.
 */
export function createPanelAnnotationSurfaceAdapter(
  options: CreatePanelAnnotationSurfaceAdapterOptions,
): AnnotationSurfaceAdapter {
  const { controller, strings } = options;
  const readCurrent = () => toPanelAnnotationSurfaceReadback(
    controller.getSnapshot(),
    options.getCurrentScopeItemIds ? options.getCurrentScopeItemIds() : undefined,
  );
  const assertRemovalContext = (expected: PanelSessionSnapshot, actual: PanelSessionSnapshot) => {
    if (actual.status.kind === "error") throw new Error(actual.status.message);
    const beforePage = expected.activePage;
    const afterPage = actual.activePage;
    if (expected.origin !== actual.origin || expected.epoch !== actual.epoch ||
        beforePage?.tabId !== afterPage?.tabId || beforePage?.frameId !== afterPage?.frameId ||
        beforePage?.origin !== afterPage?.origin || beforePage?.pathname !== afterPage?.pathname ||
        beforePage?.documentId !== afterPage?.documentId) {
      throw new Error(strings.sessionNotReady);
    }
  };
  const removeAndReadBack = async (itemId: string, expected: PanelSessionSnapshot) => {
    assertRemovalContext(expected, controller.getSnapshot());
    await controller.removeItem(itemId);
    let after = controller.getSnapshot();
    // A concurrent notification can supersede the mutation's snapshot request
    // even though storage committed. Reconcile the snapshot; never repeat deletion
    // or erase a reported storage/cleanup error with a refresh.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertRemovalContext(expected, after);
      if (!findPanelSessionItem(after.file, itemId)) return after;
      await controller.refreshActiveOrigin();
      after = controller.getSnapshot();
    }
    assertRemovalContext(expected, after);
    if (findPanelSessionItem(after.file, itemId)) throw new Error(strings.operationFailed);
    return after;
  };
  return {
    async activate(itemId) {
      await controller.refreshActiveOrigin(itemId);
      await controller.selectItem(itemId);
      const selected = controller.getSnapshot();
      if (selected.selectedItemId !== itemId || !findPanelSessionItem(selected.file, itemId)) {
        throw new Error(strings.sessionNotReady);
      }
      const currentPageItemIds = options.getCurrentPageItemIds?.();
      if (!options.getCurrentPageItemIds || currentPageItemIds?.includes(itemId)) {
        await options.activateOverlay(itemId);
      }
      return readCurrent();
    },
    stageTaskNote(itemId, note) {
      if (controller.getSnapshot().selectedItemId !== itemId) {
        throw new Error(strings.sessionNotReady);
      }
      controller.setIntent(note);
    },
    async saveTaskNote(itemId, note) {
      if (controller.getSnapshot().selectedItemId !== itemId) {
        throw new Error(strings.sessionNotReady);
      }
      controller.setIntent(note);
      if (!await controller.flushIntent()) throw new Error(strings.taskNoteSaveFailed);
      return readCurrent();
    },
    async setAnnotationLifecycle(itemId, nextState) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await controller.refreshActiveOrigin(itemId);
        const item = findPanelSessionItem(controller.getSnapshot().file, itemId);
        if (item && "annotationId" in item && typeof item.annotationId === "string") break;
      }
      const before = findPanelSessionItem(controller.getSnapshot().file, itemId);
      if (!before || !("annotationId" in before) || typeof before.annotationId !== "string") {
        throw new Error(strings.sessionNotReady);
      }
      await controller.setAnnotationLifecycle(itemId, nextState);
      const after = controller.getSnapshot();
      const updated = findPanelSessionItem(after.file, itemId);
      if (!updated || !("annotationId" in updated) ||
          updated.annotationId !== before.annotationId ||
          !("annotationLifecycle" in updated) ||
          updated.annotationLifecycle.state !== nextState) {
        throw new Error(after.status.kind === "error" ? after.status.message : strings.operationFailed);
      }
      return toPanelAnnotationSurfaceReadback(
        after,
        options.getCurrentScopeItemIds ? options.getCurrentScopeItemIds() : undefined,
      );
    },
    async remove(itemId) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await controller.refreshActiveOrigin(itemId);
        if (findPanelSessionItem(controller.getSnapshot().file, itemId)) break;
      }
      if (!findPanelSessionItem(controller.getSnapshot().file, itemId)) {
        throw new Error(strings.sessionNotReady);
      }
      const after = await removeAndReadBack(itemId, controller.getSnapshot());
      return toPanelAnnotationSurfaceReadback(
        after,
        options.getCurrentScopeItemIds ? options.getCurrentScopeItemIds() : undefined,
      );
    },
    async clear(operationId?: string) {
      const before = controller.getSnapshot();
      const clearStatus = toPanelClearStatus(before);
      const scopedItemIds = options.getCurrentScopeItemIds?.();
      const clearScope = options.getCurrentScopeKind?.() === "site"
        ? "active-origin"
        : undefined;
      if (
        operationId ||
        clearStatus.clearState === "pending" ||
        clearScope === "active-origin" ||
        scopedItemIds === undefined ||
        scopedItemIds === null
      ) {
        await controller.clearSession(
          operationId ??
          (clearStatus.clearState === "pending" ? clearStatus.operationId : options.createOperationId()),
          clearScope,
        );
        return readCurrent();
      }
      const uniqueItemIds = [...new Set(scopedItemIds)].filter((itemId) => (
        Boolean(findPanelSessionItem(controller.getSnapshot().file, itemId))
      ));
      for (const itemId of uniqueItemIds) {
        await controller.refreshActiveOrigin(itemId);
        assertRemovalContext(before, controller.getSnapshot());
        if (!findPanelSessionItem(controller.getSnapshot().file, itemId)) continue;
        await removeAndReadBack(itemId, before);
      }
      return readCurrent();
    },
    copy(detail) {
      // Start the clipboard-producing callback in the original click turn.
      // Refreshing first crosses an async runtime boundary and Chromium then
      // rejects clipboard.writeText because the transient user activation is gone.
      return options.copy(detail, controller.getSnapshot());
    },
  };
}

export function toPanelAnnotationSurfaceReadback(
  snapshot: PanelSessionSnapshot,
  authoritativeItemIds?: readonly string[] | null,
): PanelAnnotationSurfaceReadback {
  const clearStatus = toPanelClearStatus(snapshot);
  const currentScope = derivePanelCurrentScope(
    snapshot.file,
    snapshot.selectedItemId,
    snapshot.activePage,
    authoritativeItemIds === undefined ? undefined : new Set(authoritativeItemIds ?? []),
  );
  const currentItemIds = new Set(currentScope.itemIds);
  const annotationLabels = getPanelSessionAnnotationLabels(snapshot.file);
  const rows = summarizePanelSessionRows(
    snapshot.file,
    currentScope.selectedItemId,
    "agent_safe",
    snapshot.activePage,
  ).filter((row) => currentItemIds.has(row.id));
  return {
    items: rows.map((row) => {
      const item = findPanelSessionItem(snapshot.file, row.id);
      return {
        itemId: row.id,
        label: annotationLabels.get(row.id)!,
        name: row.target,
        // Saving emits before the durable record changes. Keep the selected
        // item's draft visible so continued typing cannot adopt the old value.
        taskNote: snapshot.intentDirty && row.id === snapshot.selectedItemId
          ? snapshot.intent
          : item?.sourceRecord.intent ?? "",
        annotationLifecycle: item && "annotationId" in item
          ? "annotationLifecycle" in item
            ? { ...item.annotationLifecycle }
            : { state: "open" as const, resolvedAt: null }
          : null,
      };
    }),
    activeItemId: currentScope.selectedItemId,
    clearStatus,
  };
}

function toPanelClearStatus(
  snapshot: unknown,
): PanelClearStatus {
  const fields = readExactOwnDataProperties(snapshot, PANEL_SESSION_SNAPSHOT_KEYS);
  if (fields === null) throw new Error("Invalid authoritative clear status.");
  if (fields.clearPending === false && fields.activeClearOperationId === null) {
    return { clearState: "idle", operationId: null };
  }
  if (
    fields.clearPending === true &&
    isDurableClearOperationId(fields.activeClearOperationId)
  ) {
    return { clearState: "pending", operationId: fields.activeClearOperationId };
  }
  throw new Error("Invalid authoritative clear status.");
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
