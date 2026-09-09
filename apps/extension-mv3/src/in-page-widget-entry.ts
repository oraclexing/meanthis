import "./extension-api";
import type { AttachmentFeedbackDetail } from "@meanthis/prompt";
import {
  projectPrivateDebugSummaryV1,
  serializePrivateDebugSummaryV1,
  type MetadataDiagnosticsV1,
  type PrivateDebugSummaryV1,
} from "@meanthis/schema";
import type { OriginCaptureRecord } from "./capture-store";
import {
  UI_ATTACH_ACTIVE_ORIGIN_CHANGED,
  UI_ATTACH_ELEMENT_SELECTION_UPDATED,
  UI_ATTACH_OVERLAY_PROJECTION_UPDATED,
  UI_ATTACH_SESSION_UPDATED,
  type ActiveSessionCommandData,
  type FrameScopeDescriptor,
  type SessionCommandResponse,
  type WidgetFrameScopeDescriptor,
} from "./messages";
import {
  createFrameScopeSelectionController,
  FrameScopeAccessError,
} from "./frame-scope-access";
import {
  UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
  UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
  UI_ATTACH_IN_PAGE_WIDGET_PHASE,
  UI_ATTACH_IN_PAGE_WIDGET_REGISTER,
  createInPageWidgetLifecyclePortName,
  isInPageWidgetPrivateConnectEvent,
  parseInPageWidgetActionMessage,
  parseInPageWidgetInitMessage,
  parseInPageWidgetReadyMessage,
  type InPageWidgetActionAckMessage,
  type InPageWidgetActionMessage,
  type InPageWidgetCommand,
  type InPageWidgetInitMessage,
  type InPageWidgetPrivatePhase,
} from "./in-page-widget-contract";
import {
  parseAnnotationLifecycleOperationReference,
  type AnnotationLifecycleOperationReferenceV1,
} from "./annotation-lifecycle-control-client";
import {
  createPanelSessionController,
  type PanelSessionClient,
  type PanelSessionSnapshot,
} from "./panel-session-controller";
import {
  derivePanelCurrentScope,
  findPanelSessionItem,
  summarizePanelSessionRows,
} from "./panel-session-model";
import { buildPanelAgentCopy, formatElementSelectionFailureStatus } from "./panel-model";
import type { ActiveSessionReadback } from "./session-store";
import { createUiAttachI18n, translateWidgetLifecycleMessage } from "./i18n";
import {
  createDeferredPreferenceReadbackCoordinator,
  readOverlayDisplayModePreference,
  saveOverlayDisplayModePreference,
} from "./settings-preferences";
import { LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN } from "./local-agent-bridge";
import {
  createAnnotationSurfaceController,
  createInPageWidgetStrings,
  createInPageWidgetView,
  type AnnotationSurfaceController,
  type AnnotationSurfaceCopyResult,
  type AnnotationSurfaceSnapshot,
  type InPageWidgetBridgeState,
  type InPageWidgetInteraction,
  type InPageWidgetLifecycleControlProposal,
  type InPageWidgetMode,
  type InPageWidgetReadAcknowledgementState,
  type InPageWidgetReferenceScope,
  type InPageWidgetView,
  type InPageWidgetViewModel,
  type PersistentOverlayDisplayMode,
} from "@meanthis/web-picker";
import {
  createPanelAnnotationSurfaceAdapter,
  toPanelAnnotationSurfaceReadback,
} from "./widget-annotation-adapter";

type InPageWidgetClearStatus =
  | { clearState: "idle"; operationId: null }
  | { clearState: "pending"; operationId: string };

type ClearAwareAnnotationSurfaceSnapshot = AnnotationSurfaceSnapshot & {
  clearStatus: InPageWidgetClearStatus;
};

const widgetRoot = document.querySelector<HTMLElement>("#meanthis-widget-root");
if (!widgetRoot) throw new Error("MeanThis widget root is unavailable.");
const root: HTMLElement = widgetRoot;
const PENDING_BRIDGE_REFRESH_DELAY_MS = 1_000;
const CONNECTED_BRIDGE_STATUS_DELAY_MS = 5_000;
const MAX_HANDLED_OVERLAY_ACTIONS = 128;
const FULL_SIDE_PANEL_OPEN_TIMEOUT_MS = 5_000;
const FULL_SIDE_PANEL_OPEN_TIMEOUT_ERROR =
  "MeanThis could not open the full side panel within 5 seconds. Try again.";

interface InPageWidgetActionConsumerPort {
  postMessage?(message: unknown): void;
}

export interface WidgetAnnotationLifecycleControlProposal extends
  InPageWidgetLifecycleControlProposal {
  label: string;
  reference: AnnotationLifecycleOperationReferenceV1;
}

export function parseWidgetAnnotationLifecycleControlProposal(
  value: unknown,
): WidgetAnnotationLifecycleControlProposal | null {
  const record = readExactWidgetDataRecord(value, [
    "itemId",
    "label",
    "operationId",
    "fingerprint",
    "expectedState",
    "nextState",
    "expiresAt",
    "reference",
  ]);
  const reference = record
    ? parseAnnotationLifecycleOperationReference(record.reference)
    : null;
  if (
    !record || !reference || !isBoundedIdentifier(record.itemId, 256) ||
    !isBoundedIdentifier(record.label, 512) ||
    record.operationId !== reference.operationId ||
    record.fingerprint !== reference.fingerprint ||
    (record.expectedState !== "open" && record.expectedState !== "resolved") ||
    (record.nextState !== "open" && record.nextState !== "resolved") ||
    record.expectedState === record.nextState ||
    typeof record.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.expiresAt) ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) return null;
  return {
    itemId: record.itemId,
    label: record.label,
    operationId: record.operationId,
    fingerprint: record.fingerprint,
    expectedState: record.expectedState,
    nextState: record.nextState,
    expiresAt: record.expiresAt,
    reference,
  };
}

/**
 * Keep the command/reference binding in the entry layer while exposing only
 * the display contract to the shared view. The view sanitizer intentionally
 * accepts exactly these six fields; label and reference must never cross the
 * widget DOM boundary.
 */
export function projectWidgetAnnotationLifecycleControlProposal(
  proposal: WidgetAnnotationLifecycleControlProposal | null,
): InPageWidgetLifecycleControlProposal | null {
  if (!proposal) return null;
  return {
    itemId: proposal.itemId,
    operationId: proposal.operationId,
    fingerprint: proposal.fingerprint,
    expectedState: proposal.expectedState,
    nextState: proposal.nextState,
    expiresAt: proposal.expiresAt,
  };
}

export function projectWidgetPrivateDebugSummary(
  metadataDiagnostics: unknown,
): PrivateDebugSummaryV1 | null {
  const projected = projectPrivateDebugSummaryV1(metadataDiagnostics);
  return projected.ok ? projected.value : null;
}

export interface WidgetPrivateDebugSummaryCopyResult {
  copied: boolean;
  text: string;
}

export interface WidgetPrivateDebugSummaryManualCopy {
  binding: string;
  text: string;
}

export function reconcileWidgetPrivateDebugSummaryManualCopy(
  manualCopy: WidgetPrivateDebugSummaryManualCopy | null,
  currentBinding: string | null,
): WidgetPrivateDebugSummaryManualCopy | null {
  return reconcileWidgetPrivateDebugSummaryStatusBinding(
    manualCopy?.binding ?? null,
    currentBinding,
  ) !== null
    ? manualCopy
    : null;
}

export function reconcileWidgetPrivateDebugSummaryStatusBinding(
  statusBinding: string | null,
  currentBinding: string | null,
): string | null {
  return currentBinding !== null && statusBinding === currentBinding
    ? statusBinding
    : null;
}

export async function copyWidgetPrivateDebugSummary(
  interaction: InPageWidgetInteraction,
  metadataDiagnostics: unknown,
  writeText: (text: string) => Promise<void>,
): Promise<WidgetPrivateDebugSummaryCopyResult | null> {
  if (!interaction.isTrusted) return null;
  const summary = projectWidgetPrivateDebugSummary(metadataDiagnostics);
  if (!summary) return null;
  const serialized = serializePrivateDebugSummaryV1(summary);
  if (!serialized.ok) return null;
  try {
    await writeText(serialized.value);
    return { copied: true, text: serialized.value };
  } catch {
    return { copied: false, text: serialized.value };
  }
}

function widgetPrivateDebugSummaryBinding(
  metadataDiagnostics: MetadataDiagnosticsV1 | null,
): string | null {
  if (!metadataDiagnostics || !projectWidgetPrivateDebugSummary(metadataDiagnostics)) return null;
  return `${metadataDiagnostics.captureId}\u0000${metadataDiagnostics.observedAt}`;
}

export function createWidgetAnnotationLifecycleControlDecisionCommand(
  proposal: WidgetAnnotationLifecycleControlProposal | null,
  decision: "approve" | "reject",
  operationId: string,
  fingerprint: string,
  interaction: InPageWidgetInteraction,
): InPageWidgetCommand | null {
  if (!interaction.isTrusted || !proposal || proposal.operationId !== operationId ||
      proposal.fingerprint !== fingerprint) return null;
  return {
    type: decision === "approve"
      ? "ui-attach:widget-lifecycle-control-approve"
      : "ui-attach:widget-lifecycle-control-reject",
    reference: proposal.reference,
    userActivation: true,
  };
}

interface InPageWidgetActionConsumerOptions {
  getCurrentPort(): InPageWidgetActionConsumerPort | null;
  getSurfaceId(): string | null;
  refreshActiveOrigin(itemId: string): Promise<void>;
  hasAuthoritativeItem(itemId: string): boolean;
  edit(itemId: string): Promise<boolean>;
  more(itemId: string): Promise<boolean>;
  remove?(itemId: string): Promise<void>;
  maxHandledActions?: number;
}

interface HandledInPageWidgetAction {
  fingerprint: string;
  result: Promise<InPageWidgetActionAckMessage["outcome"]>;
  acknowledgedPorts: WeakSet<object>;
}

export interface WidgetSelectionState {
  enabled: boolean;
  generation: number;
  resumeAllowed: boolean;
}

export function createInPageWidgetActionConsumer(
  options: InPageWidgetActionConsumerOptions,
): { receive(action: InPageWidgetActionMessage): void } {
  const handled = new Map<string, HandledInPageWidgetAction>();
  const maxHandledActions = options.maxHandledActions ?? MAX_HANDLED_OVERLAY_ACTIONS;

  const acknowledgeDeliveryPort = (
    action: InPageWidgetActionMessage,
    entry: HandledInPageWidgetAction,
    outcome: InPageWidgetActionAckMessage["outcome"],
    deliveryPort: ReturnType<InPageWidgetActionConsumerOptions["getCurrentPort"]>,
  ): void => {
    if (!deliveryPort || options.getCurrentPort() !== deliveryPort ||
        typeof deliveryPort !== "object" || !deliveryPort.postMessage ||
        options.getSurfaceId() !== action.surfaceId ||
        entry.acknowledgedPorts.has(deliveryPort)) return;
    try {
      deliveryPort.postMessage({
        type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
        surfaceId: action.surfaceId,
        actionId: action.actionId,
        outcome,
      });
      entry.acknowledgedPorts.add(deliveryPort);
    } catch {
      // A reconnect re-delivers the same actionId; the cached result is ACKed then.
    }
  };

  const consume = async (
    action: InPageWidgetActionMessage,
  ): Promise<InPageWidgetActionAckMessage["outcome"]> => {
    try {
      await options.refreshActiveOrigin(action.itemId);
      if (!options.hasAuthoritativeItem(action.itemId)) return "rejected";
      if (action.action === "edit") {
        return await options.edit(action.itemId) ? "consumed" : "rejected";
      }
      if (action.action === "more") {
        return await options.more(action.itemId) ? "consumed" : "rejected";
      }
      if (!options.remove) return "rejected";
      await options.remove(action.itemId);
      return "consumed";
    } catch {
      return "rejected";
    }
  };

  return {
    receive(action): void {
      if (options.getSurfaceId() !== action.surfaceId) return;
      const deliveryPort = options.getCurrentPort();
      const fingerprint = JSON.stringify([
        action.surfaceId,
        action.actionId,
        action.action,
        action.itemId,
      ]);
      let entry = handled.get(action.actionId);
      if (entry && entry.fingerprint !== fingerprint) return;
      if (!entry) {
        entry = {
          fingerprint,
          result: consume(action),
          acknowledgedPorts: new WeakSet<object>(),
        };
        handled.set(action.actionId, entry);
        while (handled.size > maxHandledActions) {
          const oldestActionId = handled.keys().next().value as string | undefined;
          if (!oldestActionId) break;
          handled.delete(oldestActionId);
        }
      }
      void entry.result.then((outcome) => {
        acknowledgeDeliveryPort(action, entry!, outcome, deliveryPort);
      });
    },
  };
}

export async function consumeInPageWidgetMore(
  surface: Pick<AnnotationSurfaceController, "more"> | null,
  itemId: string,
): Promise<boolean> {
  if (!surface) throw new Error("MeanThis widget surface is unavailable.");
  return await surface.more(itemId);
}

type FullSidePanelOpenCommand = Extract<
  InPageWidgetCommand,
  { type: "ui-attach:widget-side-panel-open" }
>;

export interface WidgetSidePanelOpenTimer {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface WidgetSidePanelOpenTiming {
  timeoutMs?: number;
  timer?: WidgetSidePanelOpenTimer;
}

type FullSidePanelOpenOutcome =
  | { kind: "resolved"; response: SessionCommandResponse<null> }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

function sendFullSidePanelOpenWithTimeout(
  send: (
    command: FullSidePanelOpenCommand,
  ) => Promise<SessionCommandResponse<null>>,
  timing: WidgetSidePanelOpenTiming,
): Promise<FullSidePanelOpenOutcome> {
  const timerApi: WidgetSidePanelOpenTimer = timing.timer ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
  const timeoutMs = timing.timeoutMs ?? FULL_SIDE_PANEL_OPEN_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: FullSidePanelOpenOutcome): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) timerApi.clearTimeout(timeoutHandle);
      resolve(outcome);
    };

    timeoutHandle = timerApi.setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    // A test timer may fire synchronously; make sure that handle is not left
    // armed even in that unusual but deterministic case.
    if (settled) timerApi.clearTimeout(timeoutHandle);

    let sendPromise: Promise<SessionCommandResponse<null>>;
    try {
      // Promise.resolve also turns a synchronous throw into a handled
      // rejection, preserving the old error propagation semantics.
      sendPromise = Promise.resolve(send({ type: "ui-attach:widget-side-panel-open" }));
    } catch (error) {
      finish({ kind: "rejected", error });
      return;
    }
    // The runtime message cannot be cancelled. Keep both handlers attached
    // after timeout so a late resolve/reject is consumed without changing the
    // already returned user-visible outcome.
    void sendPromise.then(
      (response) => finish({ kind: "resolved", response }),
      (error: unknown) => finish({ kind: "rejected", error }),
    );
  });
}

export async function openFullSidePanelFromWidgetInteraction(
  interaction: InPageWidgetInteraction,
  send: (
    command: FullSidePanelOpenCommand,
  ) => Promise<SessionCommandResponse<null>>,
  failureMessage = "MeanThis could not open the full side panel.",
  timing: WidgetSidePanelOpenTiming = {},
  directOpen?: () => Promise<void>,
): Promise<boolean> {
  if (!interaction.isTrusted) return false;
  const dispatch = directOpen
    ? (_command: FullSidePanelOpenCommand) => Promise.resolve(directOpen()).then(
        () => ({ ok: true, data: null } as const),
      )
    : send;
  const outcome = await sendFullSidePanelOpenWithTimeout(dispatch, timing);
  if (outcome.kind === "timeout") throw new Error(FULL_SIDE_PANEL_OPEN_TIMEOUT_ERROR);
  if (outcome.kind === "rejected") throw outcome.error;
  const response = outcome.response;
  if (!response.ok) throw new Error(response.error.trim() || failureMessage);
  return true;
}

export interface WidgetIntentToken {
  isCurrent(): boolean;
}

export interface WidgetBasicDiagnosticsIntent {
  enabled: boolean;
  generation: number;
}

export interface WidgetBasicDiagnosticsState {
  snapshot(): WidgetBasicDiagnosticsIntent;
  setEnabled(enabled: boolean): void;
  consume(intent: WidgetBasicDiagnosticsIntent): boolean;
  restore(intent: WidgetBasicDiagnosticsIntent, enabled: boolean): boolean;
}

export function createWidgetBasicDiagnosticsState(): WidgetBasicDiagnosticsState {
  let current: WidgetBasicDiagnosticsIntent = { enabled: false, generation: 0 };
  return {
    snapshot: () => ({ ...current }),
    setEnabled: (enabled) => {
      current = { enabled: enabled === true, generation: current.generation + 1 };
    },
    consume: (intent) => {
      if (
        intent.enabled !== true ||
        current.enabled !== true ||
        intent.generation !== current.generation
      ) {
        return false;
      }
      current = { enabled: false, generation: current.generation + 1 };
      return true;
    },
    restore: (intent, enabled) => {
      if (intent.generation !== current.generation) return false;
      current = { enabled: enabled === true, generation: current.generation + 1 };
      return true;
    },
  };
}

type WidgetSelectionSetCommand = Extract<
  InPageWidgetCommand,
  { type: "ui-attach:widget-selection-set" }
>;
type WidgetBasicDiagnosticsSetCommand = Extract<
  InPageWidgetCommand,
  { type: "ui-attach:widget-basic-diagnostics-set" }
>;

export function createWidgetSelectionSetCommand(
  enabled: boolean,
  intent: WidgetSelectionSetCommand["intent"],
  expectedGeneration: number,
  collectBasicDiagnostics = false,
): WidgetSelectionSetCommand {
  return {
    type: "ui-attach:widget-selection-set",
    enabled,
    intent,
    expectedGeneration,
    ...(enabled === true && intent === "explicit" && collectBasicDiagnostics === true
      ? { collectBasicDiagnostics: true as const }
      : {}),
  };
}

export function createWidgetBasicDiagnosticsSetCommand(
  enabled: boolean,
  expectedGeneration: number,
): WidgetBasicDiagnosticsSetCommand {
  return {
    type: "ui-attach:widget-basic-diagnostics-set",
    enabled: enabled === true,
    expectedGeneration: Number.isSafeInteger(expectedGeneration) && expectedGeneration >= 0
      ? expectedGeneration
      : 0,
  };
}

export function createSelectionIntentBarrier(): {
  beginIntent(): WidgetIntentToken;
  snapshot(): WidgetIntentToken;
} {
  let generation = 0;
  const token = (expected: number) => ({
    isCurrent: () => generation === expected,
  });
  return {
    beginIntent: () => token(++generation),
    snapshot: () => token(generation),
  };
}

export function createWidgetSelectionActionQueue(): {
  enqueue<T>(action: () => Promise<T>): Promise<T>;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue: <T>(action: () => Promise<T>): Promise<T> => {
      const pending = tail.then(action, () => action());
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
}

export async function collapseWidgetSurface(
  intent: WidgetIntentToken,
  actions: Readonly<{
    collapse(): void;
    synchronizeSelection(intent: WidgetIntentToken): Promise<boolean>;
    stopSelection(intent: WidgetIntentToken): Promise<boolean>;
    restore(): void;
  }>,
): Promise<boolean> {
  actions.collapse();
  try {
    const selectionEnabled = await actions.synchronizeSelection(intent);
    if (!intent.isCurrent() || !selectionEnabled) return false;
    return await actions.stopSelection(intent);
  } catch (error) {
    if (intent.isCurrent()) actions.restore();
    throw error;
  }
}

export function shouldRotateSelectionIntentForRuntimeUpdate(
  enabled: unknown,
  mode: InPageWidgetMode,
): boolean {
  return enabled === false && mode !== "collapsed";
}

export async function synchronizeWidgetSelectionAuthority(
  read: () => Promise<SessionCommandResponse<unknown>>,
  apply: (state: WidgetSelectionState) => void,
  intent: WidgetIntentToken,
): Promise<boolean> {
  let response: SessionCommandResponse<unknown>;
  try {
    response = await read();
  } catch {
    return false;
  }
  if (!intent.isCurrent() || !response.ok || !isWidgetSelectionState(response.data)) return false;
  apply(response.data);
  return true;
}

export async function synchronizeWidgetFrameScopes<TScope extends FrameScopeDescriptor>(
  read: () => Promise<{ currentFrameId: number; scopes: TScope[] }>,
  apply: (state: { currentFrameId: number; scopes: TScope[] }) => void,
  intent: WidgetIntentToken,
  requestIntent: WidgetIntentToken = intent,
): Promise<boolean> {
  const state = await read();
  if (!intent.isCurrent() || !requestIntent.isCurrent()) return false;
  apply(state);
  return true;
}

export async function synchronizeWidgetFrameScopeContext(
  select: () => Promise<boolean>,
  refreshSession: () => Promise<boolean>,
  refreshScopes: () => Promise<boolean>,
  commit: (enabled: boolean) => void,
  intent: WidgetIntentToken,
): Promise<boolean> {
  const enabled = await select();
  if (!intent.isCurrent()) return false;
  if (!await refreshSession() || !intent.isCurrent()) return false;
  if (!await refreshScopes() || !intent.isCurrent()) return false;
  commit(enabled);
  return true;
}

export function createWidgetFrameScopeRefreshDrain(): (
  task: Promise<boolean>, intent: WidgetIntentToken,
) => Promise<boolean> {
  let latest: Promise<boolean>;
  return async (task, intent) => {
    // Track raw reads only: following another caller's wrapper could make
    // overlapping refreshes wait on one another. No extra request is needed.
    latest = task;
    let pending = task;
    for (;;) {
      try {
        const synchronized = await pending;
        if (!intent.isCurrent()) return false;
        if (pending === latest) return synchronized;
      } catch (error) {
        if (!intent.isCurrent()) return false;
        if (pending === latest) throw error;
      }
      pending = latest;
    }
  };
}

export async function initializeWidgetCoreWithDeferredFrameScopes(
  initializeCore: () => Promise<void>,
  markAuthenticatedUiReady: () => void,
  refreshInitialFrameScopes: () => Promise<boolean>,
  startRuntimeObservation: () => void = () => undefined,
): Promise<void> {
  startRuntimeObservation();
  await initializeCore();
  markAuthenticatedUiReady();
  void refreshInitialFrameScopes().catch(() => undefined);
}

export async function settleWidgetIntentFailure(
  intent: WidgetIntentToken,
  release: () => Promise<void>,
  applyFailure: () => void,
): Promise<boolean> {
  if (!intent.isCurrent()) return false;
  await release();
  if (!intent.isCurrent()) return false;
  applyFailure();
  return true;
}

export async function runWidgetIntentAction(
  action: () => Promise<void>,
  intent: WidgetIntentToken | null,
  effects: Readonly<{
    onStart(): void;
    onRender(): void;
    onError(error: unknown): void;
    onFinally(current: boolean): void;
    onSuccess?(): void;
  }>,
): Promise<boolean> {
  const isCurrent = () => intent?.isCurrent() ?? true;
  if (!isCurrent()) return false;
  let completed = false;
  try {
    effects.onStart();
    const pending = action();
    if (isCurrent()) effects.onRender();
    await pending;
    if (isCurrent()) {
      effects.onSuccess?.();
      completed = true;
    }
  } catch (error) {
    if (isCurrent()) effects.onError(error);
  } finally {
    effects.onFinally(isCurrent());
  }
  return completed;
}

export function projectInPageWidgetClearStatus(
  snapshot: Pick<ClearAwareAnnotationSurfaceSnapshot, "clearStatus">,
): InPageWidgetClearStatus {
  return snapshot.clearStatus;
}

export function projectInPageWidgetBusyAction(
  annotationBusy: InPageWidgetViewModel["busyAction"] | undefined,
  localBusy: InPageWidgetViewModel["busyAction"],
): InPageWidgetViewModel["busyAction"] {
  return annotationBusy ?? localBusy;
}

export function projectInPageWidgetStatus(
  annotation: Readonly<{
    value: InPageWidgetViewModel["status"];
    revision: number;
  }>,
  local: Readonly<{
    value: InPageWidgetViewModel["status"];
    revision: number;
  }>,
  taskNote?: Readonly<{
    snapshot: Pick<PanelSessionSnapshot,
      "selectedItemId" | "intentDirty" | "clearPending" | "sessionMutationPending" | "status"> | null;
    activeItemId: string | null;
    strings: { saving: string; taskNoteSaveFailed: string };
  }>,
): InPageWidgetViewModel["status"] {
  const current = annotation.revision > local.revision ? annotation.value : local.value;
  const snapshot = taskNote?.snapshot;
  if (!snapshot?.intentDirty || !snapshot.selectedItemId ||
      snapshot.selectedItemId !== taskNote?.activeItemId ||
      snapshot.clearPending || snapshot.sessionMutationPending) return current;
  // Autosave runs outside annotation actions. Its failed draft remains relevant
  // until saved or discarded, even if another action has since succeeded.
  if (snapshot.status.kind === "error") {
    return { kind: "error", message: taskNote.strings.taskNoteSaveFailed };
  }
  if (snapshot.status.kind === "saving" && current?.kind !== "error") {
    return { kind: "info", message: taskNote.strings.saving };
  }
  return current;
}

export function dispatchInPageWidgetLifecycleExit(
  cause: "document-pagehide" | "surface-release",
  actions: Readonly<{
    disconnectLifecycle(): void;
    releaseSurface(): void;
  }>,
): void {
  if (cause === "surface-release") actions.releaseSurface();
  actions.disconnectLifecycle();
}

let init: InPageWidgetInitMessage | null = null;
let controller: ReturnType<typeof createPanelSessionController> | null = null;
let annotationSurface: AnnotationSurfaceController | null = null;
let view: InPageWidgetView | null = null;
let selectionEnabled = false;
let selectionAuthorityGeneration = 0;
let selectionResumeAllowed = false;
let frameScopeOpen = false;
let currentFrameId = 0;
let frameScopes: WidgetFrameScopeDescriptor[] = [];
let bridgeState: InPageWidgetBridgeState = "disconnected";
let bridgeSharedTargetCount: number | null = null;
let bridgeSharedSequence: number | null = null;
let bridgeReadAcknowledgementState: InPageWidgetReadAcknowledgementState = "unavailable";
let lifecycleControlProposal: WidgetAnnotationLifecycleControlProposal | null = null;
let bridgeExpiresAt: string | null = null;
let connectionRequestText: string | null = null;
let manualCopyText: string | null = null;
let privateDebugSummaryManualCopy: WidgetPrivateDebugSummaryManualCopy | null = null;
let privateDebugSummaryFailureStatusBinding: string | null = null;
let copiedPrivateDebugSummaryBinding: string | null = null;
let outputDetail: AttachmentFeedbackDetail = "compact";
let overlayDisplayMode: PersistentOverlayDisplayMode = "hover";
let referenceScope: InPageWidgetReferenceScope = "page";
// Fail closed until the persisted disclosure state has been read. This prevents
// the session snapshot from briefly enabling selection while that read is still
// in flight on a newly opened widget.
let disclosureRequired = true;
let mode: InPageWidgetViewModel["mode"] = "collapsed";
let status: InPageWidgetViewModel["status"] = null;
let busyAction: InPageWidgetViewModel["busyAction"] = null;
let busyActionRevision = 0;
let annotationBusyAction: InPageWidgetViewModel["busyAction"] = null;
let annotationStatus: InPageWidgetViewModel["status"] = null;
let statusRevision = 0;
let localStatusRevision = 0;
let annotationStatusRevision = 0;
let latestSnapshot: PanelSessionSnapshot | null = null;
let privatePort: MessagePort | null = null;
let lifecyclePort: ReturnType<typeof chrome.runtime.connect> | null = null;
let lifecycleSurfaceId: string | null = null;
let pendingClearConfirmation = false;
let lifecycleReconnectAttempt = 0;
let lifecycleReconnectTimer: number | null = null;
let bridgeRefreshTimer: number | null = null;
let bridgeRefreshInFlight = false;
let shuttingDown = false;
let candidateInFlight = false;
let authenticatedUiReady = false;
let stopControllerSubscription: (() => void) | null = null;
let runtimeMessageListening = false;
let displayPreferenceListening = false;
const selectionIntentBarrier = createSelectionIntentBarrier();
const selectionActionQueue = createWidgetSelectionActionQueue();
const frameScopeRefreshBarrier = createSelectionIntentBarrier();
const drainFrameScopeRefresh = createWidgetFrameScopeRefreshDrain();
const widgetActionBarrier = createSelectionIntentBarrier();
const basicDiagnosticsState = createWidgetBasicDiagnosticsState();
let basicDiagnosticsCommandRevision = 0;
const widgetI18n = createUiAttachI18n(chrome.i18n);
const widgetStrings = createInPageWidgetStrings((key, values) => (
  translateWidgetLifecycleMessage(widgetI18n.language, key) ?? widgetI18n.t(key, values)
));
const displayPreferenceCoordinator = createDeferredPreferenceReadbackCoordinator({
  write: (mode: PersistentOverlayDisplayMode) =>
    saveOverlayDisplayModePreference(chrome.storage.local, mode),
  read: () => readOverlayDisplayModePreference(chrome.storage.local),
  onValue: (mode) => {
    overlayDisplayMode = mode;
  },
  onSettled: () => { if (authenticatedUiReady) render(); },
});
type WidgetFrameScopeSelectionTarget = FrameScopeDescriptor & {
  selectionIntent: WidgetIntentToken;
  collectBasicDiagnostics?: true;
};

const frameScopeSelection = createFrameScopeSelectionController<
  WidgetFrameScopeSelectionTarget,
  WidgetIntentToken
>({
  permissions: chrome.permissions,
  isOperationCurrent: (intent) => intent?.isCurrent() ?? true,
  selectTarget: async (scope, startSelection, intent) => {
    if (!intent?.isCurrent() || !scope.selectionIntent.isCurrent()) {
      throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
    }
    const scopeResponse = await sendBoundCommand<{ enabled: boolean }>({
      type: "ui-attach:widget-frame-scope-select",
      frameId: scope.frameId,
      documentId: scope.documentId,
      origin: scope.origin,
      pathname: scope.pathname,
      expectedGeneration: selectionAuthorityGeneration,
    });
    if (!intent.isCurrent() || !scope.selectionIntent.isCurrent()) {
      throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
    }
    if (!scopeResponse.ok) throw new FrameScopeAccessError(scopeResponse.code);
    if (!isSelectionState(scopeResponse.data)) {
      throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
    }
    if (scopeResponse.data.enabled === startSelection) {
      if (startSelection && scope.collectBasicDiagnostics === true) {
        return await sendExplicitBasicDiagnosticsSelectionSet(intent, scope.selectionIntent);
      }
      return startSelection;
    }
    if (!startSelection || scopeResponse.data.enabled) {
      throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
    }
    if (scope.collectBasicDiagnostics === true) {
      return await sendExplicitBasicDiagnosticsSelectionSet(intent, scope.selectionIntent);
    }
    const selectionResponse = await sendBoundCommand<WidgetSelectionState>(
      createWidgetSelectionSetCommand(true, "explicit", selectionAuthorityGeneration),
    );
    if (!intent.isCurrent() || !scope.selectionIntent.isCurrent()) {
      throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
    }
    if (!selectionResponse.ok) throw new FrameScopeAccessError(selectionResponse.code);
    if (!isWidgetSelectionState(selectionResponse.data) || !selectionResponse.data.enabled) {
      throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
    }
    applyWidgetSelectionState(selectionResponse.data);
    return true;
  },
  stopSelection: async (intent) => {
    if (intent && !intent.isCurrent()) {
      throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
    }
    const response = await sendBoundCommand<WidgetSelectionState>(
      createWidgetSelectionSetCommand(
        false,
        "explicit",
        selectionAuthorityGeneration,
      ),
    );
    if (intent && !intent.isCurrent()) {
      throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
    }
    if (!response.ok) throw new FrameScopeAccessError(response.code);
    if (!isWidgetSelectionState(response.data) || response.data.enabled) {
      throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
    }
    applyWidgetSelectionState(response.data);
    return false;
  },
});

async function sendExplicitBasicDiagnosticsSelectionSet(
  intent: WidgetIntentToken,
  scopeIntent: WidgetIntentToken,
): Promise<boolean> {
  const stateResponse = await sendBoundCommand<WidgetSelectionState>({
    type: "ui-attach:widget-selection-read",
  });
  if (!intent.isCurrent() || !scopeIntent.isCurrent()) {
    throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
  }
  if (!stateResponse.ok) throw new FrameScopeAccessError(stateResponse.code);
  if (!isWidgetSelectionState(stateResponse.data)) {
    throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
  }
  applyWidgetSelectionState(stateResponse.data);

  const selectionResponse = await sendBoundCommand<WidgetSelectionState>(
    createWidgetSelectionSetCommand(
      true,
      "explicit",
      selectionAuthorityGeneration,
      true,
    ),
  );
  if (!intent.isCurrent() || !scopeIntent.isCurrent()) {
    throw new FrameScopeAccessError("FRAME_SCOPE_OPERATION_CANCELLED");
  }
  if (!selectionResponse.ok) throw new FrameScopeAccessError(selectionResponse.code);
  if (!isWidgetSelectionState(selectionResponse.data) || !selectionResponse.data.enabled) {
    throw new FrameScopeAccessError("INVALID_SESSION_RESPONSE");
  }
  applyWidgetSelectionState(selectionResponse.data);
  return true;
}

const overlayActionConsumer = createInPageWidgetActionConsumer({
  getCurrentPort: () => lifecyclePort,
  getSurfaceId: () => init?.surfaceId ?? lifecycleSurfaceId,
  refreshActiveOrigin: async (itemId) => {
    if (!controller) throw new Error("MeanThis widget session is unavailable.");
    await controller.refreshActiveOrigin(itemId);
  },
  hasAuthoritativeItem: (itemId) => Boolean(
    controller && findPanelSessionItem(controller.getSnapshot().file, itemId),
  ),
  edit: async (itemId) => {
    if (!annotationSurface) return false;
    const opened = await annotationSurface.edit(itemId);
    if (opened) view?.focus();
    return opened;
  },
  more: (itemId) => consumeInPageWidgetMore(annotationSurface, itemId),
  remove: async (itemId) => {
    if (!annotationSurface) throw new Error("MeanThis widget surface is unavailable.");
    await annotationSurface.remove(itemId);
  },
});

document.documentElement.lang = normalizeWidgetLanguage(chrome.i18n?.getUILanguage() ?? "en");

const handlePrivateConnect = (event: MessageEvent): void => {
  if (!isInPageWidgetPrivateConnectEvent(event, window.parent) || init) return;
  if (candidateInFlight) {
    event.ports[0]?.close();
    return;
  }
  const port = event.ports[0]!;
  port.onmessage = (portEvent) => {
    const next = parseInPageWidgetInitMessage(portEvent.data);
    if (!next || init || candidateInFlight) {
      port.close();
      return;
    }
    candidateInFlight = true;
    postPrivatePhase(port, "private-port-received");
    void authenticateCandidate(next, port);
  };
  port.start();
};
window.addEventListener("message", handlePrivateConnect);

async function authenticateCandidate(
  candidate: InPageWidgetInitMessage,
  port: MessagePort,
): Promise<void> {
  let candidateLifecyclePort: ReturnType<typeof chrome.runtime.connect> | null = null;
  let lifecycleAuthenticated = false;
  try {
    candidateLifecyclePort = await connectLifecycle(candidate, (phase) => {
      postPrivatePhase(port, phase);
    });
    lifecycleAuthenticated = true;
    if (init || shuttingDown) throw new Error("MeanThis widget initialization was superseded.");
    init = candidate;
    privatePort = port;
    lifecyclePort = candidateLifecyclePort;
    await initializeAuthenticated();
    window.removeEventListener("message", handlePrivateConnect);
    lifecycleReconnectAttempt = 0;
  } catch (error) {
    postPrivatePhase(
      port,
      lifecycleAuthenticated ? "authenticated-ui-failed" : "runtime-register-exception",
    );
    console.debug(
      `[MeanThis] Widget initialization failed: ${widgetInitializationFailureLabel(error)}.`,
    );
    if (lifecyclePort === candidateLifecyclePort) {
      lifecyclePort = null;
      lifecycleSurfaceId = null;
    }
    candidateLifecyclePort?.disconnect();
    resetAuthenticatedUi(candidate, port);
    port.close();
  } finally {
    candidateInFlight = false;
  }
}

async function initializeAuthenticated(): Promise<void> {
  if (!init) return;
  authenticatedUiReady = false;
  const client = createWidgetSessionClient();
  controller = createPanelSessionController({
    client,
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (id) => window.clearTimeout(id as number),
  });
  annotationSurface?.dispose();
  annotationSurface = createAnnotationSurfaceController({
    adapter: createWidgetAnnotationAdapter(),
    initialMode: mode,
    initialOutputDetail: outputDetail,
    initialReadiness: "hydrating",
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (id) => window.clearTimeout(id as number),
    strings: {
      taskNoteSaved: widgetStrings.taskNoteSaved,
      copySucceeded: widgetStrings.copySucceeded,
      copyFailed: widgetStrings.copyFailed,
      operationFailed: widgetStrings.operationFailed,
      annotationResolved: widgetStrings.annotationResolved,
      annotationReopened: widgetStrings.annotationReopened,
      annotationLifecycleUnconfirmed: widgetStrings.annotationLifecycleUnconfirmed,
      annotationsClearPending: (
        widgetStrings as typeof widgetStrings & { clearPending: string }
      ).clearPending,
    } as NonNullable<Parameters<typeof createAnnotationSurfaceController>[0]["strings"]> & {
      annotationsClearPending: string;
    },
    beforeClear: () => {
      selectionIntentBarrier.beginIntent();
      frameScopeOpen = false;
      selectionEnabled = false;
      setWidgetMode("ready");
    },
    onChange: applyAnnotationSurfaceSnapshot,
  });
  view = createInPageWidgetView({
    document,
    callbacks: {
      onExpand: () => {
        disarmClearConfirmation();
        frameScopeOpen = false;
        if (disclosureRequired) {
          setWidgetMode("details");
          return;
        }
        const basicDiagnosticsIntent = currentBasicDiagnosticsIntent();
        const intent = selectionIntentBarrier.beginIntent();
        void runSelectionAction(intent, async () => {
          setWidgetMode("ready");
          selectionEnabled = await setWidgetSelectionEnabled(
            true,
            intent,
            basicDiagnosticsIntent,
          );
          if (!intent.isCurrent()) return;
          setWidgetMode(selectionEnabled ? "selecting" : "ready");
        }, () => consumeBasicDiagnosticsIntent(basicDiagnosticsIntent));
      },
      onCollapse: () => {
        const intent = selectionIntentBarrier.beginIntent();
        disarmClearConfirmation();
        frameScopeOpen = false;
        setWidgetMode("collapsed");
        void runSelectionAction(intent, async () => {
          selectionEnabled = await collapseWidgetSurface(intent, {
            collapse: () => setWidgetMode("collapsed"),
            synchronizeSelection: async (readIntent) => {
              if (!await refreshSelectionState(readIntent)) {
                if (!readIntent.isCurrent()) return false;
                throw new Error(widgetStrings.operationFailed);
              }
              return selectionEnabled;
            },
            stopSelection: (stopIntent) => setWidgetSelectionEnabled(false, stopIntent),
            restore: () => setWidgetMode(selectionEnabled ? "selecting" : "ready"),
          });
          if (!intent.isCurrent()) return;
          if (selectionEnabled) {
            setWidgetMode("selecting");
            throw new Error(widgetStrings.operationFailed);
          }
        });
      },
      onStartSelection: () => {
        const basicDiagnosticsIntent = disclosureRequired
          ? null
          : currentBasicDiagnosticsIntent();
        const intent = selectionIntentBarrier.beginIntent();
        void runSelectionAction(intent, async () => {
          disarmClearConfirmation();
          frameScopeOpen = false;
          if (disclosureRequired) {
            setWidgetStatus({ kind: "info", message: widgetStrings.disclosureIntro });
            return;
          }
          selectionEnabled = await setWidgetSelectionEnabled(
            true,
            intent,
            basicDiagnosticsIntent,
          );
          if (!intent.isCurrent()) return;
          setWidgetMode(selectionEnabled ? "selecting" : "ready");
        }, () => consumeBasicDiagnosticsIntent(basicDiagnosticsIntent));
      },
      onStopSelection: () => {
        const intent = selectionIntentBarrier.beginIntent();
        void runSelectionAction(intent, async () => {
          disarmClearConfirmation();
          frameScopeOpen = false;
          selectionEnabled = await setWidgetSelectionEnabled(false, intent);
          if (!intent.isCurrent()) return;
          setWidgetMode("ready");
        });
      },
      onToggleFrameScopes: () => {
        disarmClearConfirmation();
        if (frameScopeOpen) {
          frameScopeOpen = false;
          render();
          return;
        }
        const intent = selectionIntentBarrier.snapshot();
        void runAction(async () => {
          setWidgetBusyAction("frame-scope");
          if (!await refreshFrameScopes(intent) || !intent.isCurrent()) return;
          frameScopeOpen = true;
        }, intent);
      },
      onCloseFrameScopes: () => {
        frameScopeOpen = false;
        render();
      },
      onSelectFrameScope: (scopeId) => void selectWidgetFrameScope(scopeId),
      onActivateTarget: (itemId) => void annotationSurface?.edit(itemId).then((opened) => {
        if (opened) view?.focus();
      }),
      onEditTarget: (itemId) => void annotationSurface?.edit(itemId).then((opened) => {
        if (opened) view?.focus();
      }),
      onCloseEditor: () => {
        annotationSurface?.closeEditor();
      },
      onTaskNoteChange: (itemId, note) => annotationSurface?.setTaskNote(itemId, note),
      onApplyShortcut: (itemId, _shortcutId, note) => annotationSurface?.setTaskNote(itemId, note),
      onSave: (itemId, note) => {
        annotationSurface?.setTaskNote(itemId, note);
        void annotationSurface?.save(itemId);
      },
      onSetAnnotationLifecycle: (itemId, nextState, interaction) => {
        if (!interaction.isTrusted) return;
        void annotationSurface?.setAnnotationLifecycle(itemId, nextState);
      },
      onApproveLifecycleControlProposal: (
        operationId,
        fingerprint,
        interaction,
      ) => void decideWidgetAnnotationLifecycleControlProposal(
        "approve",
        operationId,
        fingerprint,
        interaction,
      ),
      onRejectLifecycleControlProposal: (
        operationId,
        fingerprint,
        interaction,
      ) => void decideWidgetAnnotationLifecycleControlProposal(
        "reject",
        operationId,
        fingerprint,
        interaction,
      ),
      onRemoveTarget: (itemId) => void annotationSurface?.remove(itemId),
      onCopy: () => {
        annotationSurface?.disarmClearConfirmation();
        void annotationSurface?.copy();
      },
      onClear: () => void annotationSurface?.requestClear(),
      onDiscardRecovery: () => {
        const activeController = controller;
        if (!activeController) return;
        void runAction(async () => {
          await activeController.discardDirtyIntent();
          if (activeController.getSnapshot().recovery) {
            throw new Error(widgetStrings.operationFailed);
          }
        });
      },
      onOpenSettings: () => {
        disarmClearConfirmation();
        frameScopeOpen = false;
        setWidgetMode(mode === "details" || mode === "editing"
          ? selectionEnabled ? "selecting" : "ready"
          : "details");
        if (mode === "details") {
          const intent = selectionIntentBarrier.beginIntent();
          void runSelectionAction(intent, async () => {
            selectionEnabled = await setWidgetSelectionEnabled(false, intent);
            if (!intent.isCurrent()) return;
            if (selectionEnabled) throw new Error(widgetStrings.operationFailed);
          });
          // Another surface can connect while this widget is disconnected.
          // Refresh on entry so the acknowledgement controls reflect that link.
          void refreshBridgeState().then(() => {
            if (!shuttingDown) render();
          });
        }
      },
      onOpenFullSidePanel: (interaction) => {
        if (!interaction.isTrusted) return;
        const directSidePanel = chrome.sidePanel;
        void runAction(async () => {
          setWidgetBusyAction("side-panel");
          await openFullSidePanelFromWidgetInteraction(
            interaction,
            (command) => sendBoundCommand<null>(command),
            widgetStrings.fullSidePanelOpenFailed,
            {},
            typeof directSidePanel?.open === "function"
              ? () => directSidePanel.open({ windowId: -2 })
              : undefined,
          );
        }, null, () => {
          setWidgetStatus({ kind: "success", message: widgetStrings.fullSidePanelOpened });
        });
      },
      onOutputDetailChange: (detail) => {
        annotationSurface?.setOutputDetail(detail);
      },
      onDisplayModeChange: (nextMode) => queueOverlayDisplayModeWrite(nextMode),
      onCollectBasicDiagnosticsChange: (enabled) => {
        const previousBasicDiagnosticsIntent = basicDiagnosticsState.snapshot();
        basicDiagnosticsState.setEnabled(enabled);
        const basicDiagnosticsCommandIntent = basicDiagnosticsState.snapshot();
        const basicDiagnosticsIntent = enabled ? currentBasicDiagnosticsIntent() : null;
        const intent = selectionIntentBarrier.beginIntent();
        render();
        void runAction(async () => {
          setWidgetBusyAction("diagnostics");
          if (!await refreshSelectionState(intent)) {
            if (basicDiagnosticsState.restore(
              basicDiagnosticsCommandIntent,
              previousBasicDiagnosticsIntent.enabled,
            )) render();
            throw new Error(widgetStrings.operationFailed);
          }
          if (!intent.isCurrent()) return;
          const response = await sendBoundCommand<WidgetSelectionState>(
            createWidgetBasicDiagnosticsSetCommand(enabled, selectionAuthorityGeneration),
          );
          if (!intent.isCurrent()) return;
          if (!response.ok) {
            if (basicDiagnosticsState.restore(
              basicDiagnosticsCommandIntent,
              previousBasicDiagnosticsIntent.enabled,
            )) render();
            throw new Error(safeMessage(response.error));
          }
          if (!isWidgetSelectionState(response.data)) {
            throw new Error(widgetStrings.operationFailed);
          }
          applyWidgetSelectionState(response.data);
        }, intent, () => {
          basicDiagnosticsCommandRevision += 1;
          if (enabled && selectionEnabled) {
            consumeBasicDiagnosticsIntent(basicDiagnosticsIntent);
          } else {
            render();
          }
        });
      },
      onCopyPrivateDebugSummary: (interaction) => {
        if (!interaction.isTrusted) return;
        disarmClearConfirmation();
        const metadataDiagnostics = latestSnapshot?.metadataDiagnostics ?? null;
        const summaryBinding = widgetPrivateDebugSummaryBinding(metadataDiagnostics);
        let copyOutcome: "stale" | "unavailable" | "manual" | "copied" = "stale";
        void runAction(async () => {
          setWidgetBusyAction("diagnostics");
          const clipboardWrite = typeof navigator.clipboard?.writeText === "function"
            ? (text: string) => navigator.clipboard.writeText(text)
            : async () => {
                throw new Error("Clipboard unavailable.");
              };
          const result = await copyWidgetPrivateDebugSummary(
            interaction,
            metadataDiagnostics,
            clipboardWrite,
          );
          const currentSummaryBinding = widgetPrivateDebugSummaryBinding(
            latestSnapshot?.metadataDiagnostics ?? null,
          );
          if (summaryBinding === null || currentSummaryBinding !== summaryBinding) {
            privateDebugSummaryManualCopy = reconcileWidgetPrivateDebugSummaryManualCopy(
              privateDebugSummaryManualCopy,
              currentSummaryBinding,
            );
            return;
          }
          if (!result) {
            privateDebugSummaryManualCopy = null;
            copyOutcome = "unavailable";
            return;
          }
          if (!result.copied) {
            privateDebugSummaryManualCopy = {
              binding: summaryBinding,
              text: result.text,
            };
            copyOutcome = "manual";
            return;
          }
          privateDebugSummaryManualCopy = null;
          copiedPrivateDebugSummaryBinding = summaryBinding;
          copyOutcome = "copied";
        }, null, () => {
          if (summaryBinding === null || summaryBinding !== widgetPrivateDebugSummaryBinding(
            latestSnapshot?.metadataDiagnostics ?? null,
          )) return;
          if (copyOutcome === "manual") {
            setWidgetPrivateDebugSummaryCopyFailureStatus(summaryBinding);
            return;
          }
          if (copyOutcome === "unavailable") {
            setWidgetStatus({ kind: "error", message: widgetStrings.operationFailed });
            return;
          }
          if (copyOutcome !== "copied") return;
          setWidgetStatus({
            kind: "success",
            message: widgetStrings.privateDebugSummaryCopied,
          });
        });
      },
      onReferenceScopeChange: (nextScope) => {
        disarmClearConfirmation();
        referenceScope = nextScope;
        if (latestSnapshot) {
          annotationSurface?.applyReadback(toPanelAnnotationSurfaceReadback(
            latestSnapshot,
            currentWidgetReferenceScopeItemIds(latestSnapshot),
          ));
        }
        render();
      },
      onMoreTarget: (itemId) => void annotationSurface?.more(itemId),
      onAcknowledgeDisclosure: () => void acknowledgeDisclosure(),
      onCreateInvitation: () => void createInvitation(),
      onRefreshConnection: () => void refreshConnection(),
      onDisconnect: () => void disconnectBridge(),
      onCopyInvitation: (text) => void copyInvitation(text),
    },
    strings: widgetStrings,
  });
  root.replaceChildren(view.element);
  if (lifecycleControlProposal) {
    void openWidgetAnnotationLifecycleControlProposal(lifecycleControlProposal);
  }
  stopControllerSubscription = controller.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    const currentSummaryBinding = widgetPrivateDebugSummaryBinding(snapshot.metadataDiagnostics);
    privateDebugSummaryManualCopy = reconcileWidgetPrivateDebugSummaryManualCopy(
      privateDebugSummaryManualCopy,
      currentSummaryBinding,
    );
    const nextFailureStatusBinding = reconcileWidgetPrivateDebugSummaryStatusBinding(
      privateDebugSummaryFailureStatusBinding,
      currentSummaryBinding,
    );
    if (privateDebugSummaryFailureStatusBinding !== null && nextFailureStatusBinding === null) {
      setWidgetStatus(null);
    }
    privateDebugSummaryFailureStatusBinding = nextFailureStatusBinding;
    if (copiedPrivateDebugSummaryBinding !== currentSummaryBinding) {
      copiedPrivateDebugSummaryBinding = null;
    }
    annotationSurface?.applyReadback(toPanelAnnotationSurfaceReadback(
      snapshot,
      currentWidgetReferenceScopeItemIds(snapshot),
    ));
    render();
  });
  // Resolve disclosure before loading the actionable session surface. A session
  // read can complete synchronously, while storage-backed disclosure state may
  // take longer after an MV3 worker restart.
  await runWidgetInitializationStage("disclosure", refreshDisclosureState());
  await initializeWidgetCoreWithDeferredFrameScopes(async () => {
    const annotationHydration = controller!.initialize().then(() => {
      annotationSurface?.setReadiness("ready");
    });
    await Promise.all([
      runWidgetInitializationStage("session", annotationHydration),
      runWidgetInitializationStage("bridge", refreshBridgeState()),
      runWidgetInitializationStage("selection", refreshSelectionState()),
      runWidgetInitializationStage("display-preference", refreshOverlayDisplayMode()),
    ]);
    if (!displayPreferenceListening) {
      chrome.storage.onChanged.addListener(handleDisplayPreferenceStorageChange);
      displayPreferenceListening = true;
    }
  }, () => {
    authenticatedUiReady = true;
    render();
    postPrivatePhase(privatePort, "authenticated-ui-ready");
    postLayout(resolveWidgetLayout());
  }, () => refreshFrameScopes(), () => {
    if (!runtimeMessageListening) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      runtimeMessageListening = true;
    }
  });
}

async function runWidgetInitializationStage<T>(stage: string, task: Promise<T>): Promise<T> {
  try {
    return await task;
  } catch {
    throw new Error(`MeanThis widget initialization failed at ${stage}.`);
  }
}

function widgetInitializationFailureLabel(error: unknown): string {
  if (!(error instanceof Error)) return "setup-unknown";
  if (/^MeanThis widget initialization failed at [a-z-]+\.$/u.test(error.message)) {
    return error.message.slice("MeanThis widget initialization failed at ".length, -1);
  }
  const bounded = error.message.replace(/[^a-zA-Z0-9 .:_-]/gu, "?").slice(0, 160).trim();
  return bounded ? `setup: ${bounded}` : "setup-unknown";
}

async function connectLifecycle(
  candidate: InPageWidgetInitMessage | null = init,
  reportPhase?: (phase: InPageWidgetPrivatePhase) => void,
): Promise<ReturnType<typeof chrome.runtime.connect>> {
  if (!candidate || shuttingDown) throw new Error("MeanThis widget is closing.");
  const registered = await chrome.runtime.sendMessage({
    type: UI_ATTACH_IN_PAGE_WIDGET_REGISTER,
    surfaceId: candidate.surfaceId,
    capability: candidate.capability,
  });
  if (!isRegisteredResponse(registered)) {
    reportPhase?.(registrationFailurePhase(registered));
    throw new Error("MeanThis widget registration failed.");
  }
  reportPhase?.("runtime-register-ok");
  const nextPort = chrome.runtime.connect({
    name: createInPageWidgetLifecyclePortName(candidate.surfaceId, candidate.capability),
  });
  lifecyclePort = nextPort;
  lifecycleSurfaceId = candidate.surfaceId;
  try {
    await awaitLifecycleReady(nextPort, candidate.surfaceId);
    reportPhase?.("lifecycle-ready");
    return nextPort;
  } catch (error) {
    if (lifecyclePort === nextPort) {
      lifecyclePort = null;
      lifecycleSurfaceId = null;
    }
    nextPort.disconnect();
    throw error;
  }
}

export function registrationFailurePhase(value: unknown): InPageWidgetPrivatePhase {
  if (!isRecord(value)) return "runtime-register-invalid-response";
  if (value.ok !== false) return "runtime-register-invalid-response";
  if (!Array.isArray(value.issues) || !isRecord(value.issues[0]) ||
      typeof value.issues[0].message !== "string") {
    if (value.code === "CAPTURE_FAILED") return "runtime-register-handler-exception";
    if (value.code === "UNTRUSTED_SENDER") return "runtime-register-untrusted-response";
    return "runtime-register-invalid-response";
  }
  switch (value.issues[0].message) {
    case "WIDGET_REGISTER_MISSING_ID":
      return "runtime-register-missing-id";
    case "WIDGET_REGISTER_TAB_CONTEXT":
      return "runtime-register-tab-context";
    case "WIDGET_REGISTER_FRAME_CONTEXT":
      return "runtime-register-frame-context";
    case "WIDGET_REGISTER_LEASE":
      return "runtime-register-lease";
    case "WIDGET_REGISTER_TOP_INVENTORY":
      return "runtime-register-top-inventory";
    case "WIDGET_REGISTER_WIDGET_URL":
      return "runtime-register-widget-url";
    case "WIDGET_REGISTER_TOP_DOCUMENT":
      return "runtime-register-top-document";
    case "WIDGET_REGISTER_WIDGET_DOCUMENT":
      return "runtime-register-widget-document";
    case "WIDGET_REGISTER_TOP_ROUTE":
      return "runtime-register-top-route";
    case "WIDGET_REGISTER_HANDLER_EXCEPTION":
      return "runtime-register-handler-exception";
    default:
      return "runtime-register-unknown-issue";
  }
}

function postPrivatePhase(port: MessagePort | null, phase: InPageWidgetPrivatePhase): void {
  try {
    port?.postMessage({ type: UI_ATTACH_IN_PAGE_WIDGET_PHASE, phase });
  } catch {
    // The authenticated layout acknowledgement remains the only readiness
    // signal. Diagnostics never keep a failed private channel alive.
  }
}

async function awaitLifecycleReady(
  port: ReturnType<typeof chrome.runtime.connect>,
  surfaceId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("MeanThis widget registration timed out."));
    }, 4_000);
    port.onMessage?.addListener((message) => {
      const readyMessage = parseInPageWidgetReadyMessage(message);
      if (!ready && readyMessage?.surfaceId === surfaceId) {
        ready = true;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve();
        return;
      }
      const widgetAction = parseInPageWidgetActionMessage(message);
      if (!ready || !widgetAction || widgetAction.surfaceId !== surfaceId) return;
      receiveOverlayAction(widgetAction);
    });
    port.onDisconnect.addListener(() => {
      if (!ready) {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeoutId);
          reject(new Error("MeanThis widget registration was interrupted."));
        }
        return;
      }
      if (lifecyclePort !== port || shuttingDown) return;
      lifecyclePort = null;
      lifecycleSurfaceId = null;
      setWidgetStatus({ kind: "info", message: widgetStrings.reconnecting });
      scheduleLifecycleReconnect();
    });
  });
}

function scheduleLifecycleReconnect(): void {
  if (shuttingDown || lifecycleReconnectTimer !== null) return;
  const delay = Math.min(4_000, 250 * (2 ** lifecycleReconnectAttempt));
  lifecycleReconnectAttempt = Math.min(lifecycleReconnectAttempt + 1, 4);
  lifecycleReconnectTimer = window.setTimeout(() => {
    lifecycleReconnectTimer = null;
    void connectLifecycle().then((nextPort) => {
      if (shuttingDown) {
        if (lifecyclePort === nextPort) {
          lifecyclePort = null;
          lifecycleSurfaceId = null;
        }
        nextPort.disconnect();
        return;
      }
      lifecyclePort = nextPort;
      lifecycleSurfaceId = init?.surfaceId ?? null;
      lifecycleReconnectAttempt = 0;
      setWidgetStatus(null);
      const intent = selectionIntentBarrier.snapshot();
      void reconcileSelectionAfterLifecycleReconnect(intent).catch(async (error) => {
        await settleWidgetIntentFailure(
          intent,
          () => frameScopeSelection.releasePermission().catch(() => undefined),
          () => {
            selectionEnabled = false;
            if (mode === "ready" || mode === "selecting") setWidgetMode("ready");
            setWidgetStatus({
              kind: "error",
              message: error instanceof Error
                ? safeMessage(error.message)
                : widgetStrings.operationFailed,
            });
          },
        );
      }).finally(() => {
        if (intent.isCurrent()) render();
      });
    }).catch(() => scheduleLifecycleReconnect());
  }, delay);
}

async function reconcileSelectionAfterLifecycleReconnect(intent: WidgetIntentToken): Promise<void> {
  const shouldResumeSelection = mode === "selecting";
  await Promise.all([
    controller?.refreshActiveOrigin(),
    refreshBridgeState(),
    refreshFrameScopes(intent),
  ]);
  await refreshSelectionState(intent);
  if (!intent.isCurrent()) return;
  if (!selectionEnabled && shouldResumeSelection && selectionResumeAllowed) {
    const response = await sendBoundCommand<WidgetSelectionState>(
      createWidgetSelectionSetCommand(
        true,
        "resume",
        selectionAuthorityGeneration,
      ),
    );
    if (!intent.isCurrent()) return;
    if (!response.ok || !isWidgetSelectionState(response.data)) {
      throw new Error(response.ok ? widgetStrings.operationFailed : safeMessage(response.error));
    }
    applyWidgetSelectionState(response.data);
  }
  if (!intent.isCurrent()) return;
  if (mode === "ready" || mode === "selecting") {
    setWidgetMode(selectionEnabled ? "selecting" : "ready");
  }
}

function createWidgetSessionClient(): PanelSessionClient {
  return {
    getActive: () => sendBoundCommand<ActiveSessionCommandData>({
      type: "ui-attach:widget-session-read",
    }),
    updateIntent: (_origin, epoch, itemId, intent) => sendBoundCommand<ActiveSessionReadback>({
      type: "ui-attach:widget-task-note-save",
      expectedEpoch: epoch,
      itemId,
      taskNote: intent,
    }),
    updateAnnotationLifecycle: (
      _origin,
      epoch,
      itemId,
      annotationId,
      expectedState,
      nextState,
    ) => sendBoundCommand<ActiveSessionReadback>({
      type: "ui-attach:widget-annotation-lifecycle-set",
      expectedEpoch: epoch,
      itemId,
      annotationId,
      expectedState,
      nextState,
    }),
    removeItem: (_origin, epoch, itemId) => sendBoundCommand<ActiveSessionReadback>({
      type: "ui-attach:widget-item-remove",
      expectedEpoch: epoch,
      itemId,
    }),
    clear: (_origin, epoch, operationId, scope = "live-page") => sendBoundCommand<ActiveSessionReadback>({
      type: "ui-attach:widget-session-clear",
      expectedEpoch: epoch,
      operationId,
      scope,
    }),
  };
}

function createWidgetAnnotationAdapter() {
  const adapter = createPanelAnnotationSurfaceAdapter({
    controller: requireSessionController(),
    getCurrentScopeItemIds: currentWidgetReferenceScopeItemIds,
    getCurrentScopeKind: () => referenceScope,
    getCurrentPageItemIds: currentWidgetPageItemIds,
    activateOverlay: async (itemId) => {
      const response = await sendBoundCommand<null>({
        type: "ui-attach:widget-overlay-active",
        itemId,
      });
      if (!response.ok) throw new Error(response.error);
    },
    copy: copyAnnotationHandoff,
    createOperationId: () => crypto.randomUUID(),
    strings: {
      operationFailed: widgetStrings.operationFailed,
      sessionNotReady: widgetStrings.sessionNotReady,
      taskNoteSaveFailed: widgetStrings.taskNoteSaveFailed,
    },
  });
  return {
    ...adapter,
    async clear(operationId?: string) {
      const readback = await adapter.clear(operationId);
      const intent = selectionIntentBarrier.beginIntent();
      await refreshSelectionState(intent);
      return readback;
    },
  };
}

function requireSessionController(): ReturnType<typeof createPanelSessionController> {
  if (!controller) throw new Error(widgetStrings.sessionNotReady);
  return controller;
}

function applyAnnotationSurfaceSnapshot(snapshot: AnnotationSurfaceSnapshot): void {
  const transientStateChanged = annotationBusyAction !== snapshot.busyAction ||
    !sameWidgetStatus(annotationStatus, snapshot.status);
  if (transientStateChanged) {
    widgetActionBarrier.beginIntent();
    annotationStatusRevision = ++statusRevision;
  }
  annotationBusyAction = snapshot.busyAction;
  annotationStatus = snapshot.status;
  mode = snapshot.mode;
  outputDetail = snapshot.outputDetail;
  pendingClearConfirmation = snapshot.clearConfirmationRequired;
  manualCopyText = snapshot.manualCopyText;
  render();
}

function setWidgetMode(nextMode: InPageWidgetViewModel["mode"]): void {
  if (annotationSurface) annotationSurface.setMode(nextMode);
  else {
    mode = nextMode;
    render();
  }
}

function setWidgetStatus(nextStatus: InPageWidgetViewModel["status"]): void {
  privateDebugSummaryFailureStatusBinding = null;
  status = nextStatus;
  localStatusRevision = ++statusRevision;
  render();
}

function setWidgetPrivateDebugSummaryCopyFailureStatus(binding: string): void {
  status = {
    kind: "error",
    message: widgetStrings.privateDebugSummaryCopyFailed,
  };
  privateDebugSummaryFailureStatusBinding = binding;
  localStatusRevision = ++statusRevision;
  render();
}

function sameWidgetStatus(
  left: InPageWidgetViewModel["status"],
  right: InPageWidgetViewModel["status"],
): boolean {
  return left === right || Boolean(
    left && right && left.kind === right.kind && left.message === right.message,
  );
}

function setWidgetBusyAction(nextAction: InPageWidgetViewModel["busyAction"]): void {
  busyActionRevision += 1;
  busyAction = nextAction;
  render();
}

async function sendBoundCommand<T>(command: InPageWidgetCommand): Promise<SessionCommandResponse<T>> {
  if (!init) throw new Error("MeanThis widget is not registered.");
  const response = await chrome.runtime.sendMessage({
    type: UI_ATTACH_IN_PAGE_WIDGET_COMMAND,
    surfaceId: init.surfaceId,
    capability: init.capability,
    command,
  });
  const normalized: SessionCommandResponse<T> = isCommandResponse<T>(response)
    ? response
    : { ok: false as const, code: "INVALID_RESPONSE", error: "MeanThis widget action failed." };
  if (!normalized.ok) {
    console.debug(
      `[MeanThis] Widget command failed: ${command.type}:` +
        `${normalizeWidgetCommandFailureCode(normalized.code)}.`,
    );
  }
  return normalized;
}

export function normalizeWidgetCommandFailureCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)
    ? value
    : "UNKNOWN";
}

async function refreshSelectionState(
  intent = selectionIntentBarrier.snapshot(),
): Promise<boolean> {
  const synchronized = await synchronizeWidgetSelectionAuthority(
    () => sendBoundCommand<WidgetSelectionState>({
      type: "ui-attach:widget-selection-read",
    }),
    applyWidgetSelectionState,
    intent,
  );
  if (!intent.isCurrent()) return false;
  if (!synchronized) {
    selectionEnabled = false;
    selectionResumeAllowed = false;
    return false;
  }
  return true;
}

async function refreshFrameScopes(
  intent = selectionIntentBarrier.snapshot(),
): Promise<boolean> {
  const requestIntent = frameScopeRefreshBarrier.beginIntent();
  const synchronized = await drainFrameScopeRefresh(synchronizeWidgetFrameScopes(async () => {
    const response = await sendBoundCommand<unknown>({
      type: "ui-attach:widget-frame-scope-list",
    });
    if (!response.ok) throw new Error(formatFrameScopeFailure(response.code));
    const next = parseWidgetFrameScopeListData(response.data);
    if (!next) throw new Error(widgetStrings.operationFailed);
    return next;
  }, (next) => {
    currentFrameId = next.currentFrameId;
    frameScopes = next.scopes;
  }, intent, requestIntent), intent);
  if (synchronized) {
    if (latestSnapshot) {
      annotationSurface?.applyReadback(toPanelAnnotationSurfaceReadback(
        latestSnapshot,
        currentWidgetReferenceScopeItemIds(latestSnapshot),
      ));
    }
    render();
  }
  return synchronized;
}

function currentWidgetPageItemIds(snapshot = latestSnapshot): readonly string[] | null {
  const frameItemIds = frameScopes.find((scope) => scope.frameId === currentFrameId)?.itemIds;
  if (!snapshot) return null;
  const derivedItemIds = derivePanelCurrentScope(
    snapshot.file,
    snapshot.selectedItemId,
    snapshot.activePage,
  ).itemIds;
  return resolveWidgetPageItemIds(snapshot.currentItemIds, frameItemIds, derivedItemIds);
}

export function resolveWidgetPageItemIds(
  sessionItemIds: readonly string[] | null,
  frameItemIds: readonly string[] | null | undefined,
  derivedItemIds: readonly string[],
): readonly string[] {
  return sessionItemIds ?? frameItemIds ?? derivedItemIds;
}

function currentWidgetSiteItemIds(snapshot = latestSnapshot): readonly string[] | null {
  if (!snapshot?.file) return [];
  const origin = snapshot.activePage?.origin ?? snapshot.origin;
  if (!origin) return [];
  return snapshot.file.session.attachments
    .filter((item) => (item.sourceRecord as OriginCaptureRecord).origin === origin)
    .map((item) => item.id);
}

function currentWidgetReferenceScopeItemIds(
  snapshot = latestSnapshot,
): readonly string[] | null {
  return referenceScope === "site"
    ? currentWidgetSiteItemIds(snapshot)
    : currentWidgetPageItemIds(snapshot);
}

function currentWidgetSiteLabel(snapshot = latestSnapshot): string {
  const origin = snapshot?.activePage?.origin ?? snapshot?.origin;
  if (!origin) return "site";
  try {
    return new URL(origin).hostname || "site";
  } catch {
    return "site";
  }
}

async function setWidgetSelectionEnabled(
  enabled: boolean,
  intent = selectionIntentBarrier.beginIntent(),
  basicDiagnosticsIntent: WidgetBasicDiagnosticsIntent | null = null,
): Promise<boolean> {
  if (enabled && !await refreshSelectionState(intent)) {
    if (!intent.isCurrent()) return selectionEnabled;
    throw new Error(widgetStrings.operationFailed);
  }
  if (!intent.isCurrent()) return selectionEnabled;
  if (enabled && frameScopes.length === 0) {
    if (!await refreshFrameScopes(intent)) {
      if (!intent.isCurrent()) return selectionEnabled;
      throw new Error(widgetStrings.operationFailed);
    }
  }
  const currentScope = enabled
    ? frameScopes.find((scope) => scope.frameId === currentFrameId) ?? null
    : null;
  if (!enabled) {
    const stopped = await stopFrameScopeSelection(intent);
    return intent.isCurrent() ? stopped : selectionEnabled;
  }
  if (!currentScope?.selectable) throw new Error(widgetStrings.captureScopeUnavailable);
  const selected = await selectFrameScopeWithLease(
    currentScope,
    true,
    intent,
    basicDiagnosticsIntent,
  );
  return intent.isCurrent() ? selected : selectionEnabled;
}

async function selectWidgetFrameScope(scopeId: string): Promise<void> {
  const intent = selectionIntentBarrier.beginIntent();
  const startSelection = selectionEnabled;
  const basicDiagnosticsIntent = startSelection ? currentBasicDiagnosticsIntent() : null;
  let shouldConsumeBasicDiagnostics = false;
  await runAction(async () => {
    const scope = frameScopes.find((candidate) => frameScopeId(candidate) === scopeId);
    if (!scope?.selectable) throw new Error(widgetStrings.captureScopeUnavailable);
    if (scope.frameId === currentFrameId) {
      frameScopeOpen = false;
      return;
    }
    shouldConsumeBasicDiagnostics = basicDiagnosticsIntent !== null;
    setWidgetBusyAction("frame-scope");
    const synchronized = await synchronizeWidgetFrameScopeContext(
      () => selectFrameScopeWithLease(
        scope,
        startSelection,
        intent,
        basicDiagnosticsIntent,
      ),
      async () => {
        if (!controller) return false;
        await controller.refreshActiveOrigin();
        const activePage = controller.getSnapshot().activePage;
        return Boolean(
          activePage &&
          activePage.frameId === scope.frameId &&
          activePage.documentId === scope.documentId &&
          activePage.origin === scope.origin &&
          activePage.pathname === scope.pathname
        );
      },
      () => refreshFrameScopes(intent),
      (enabled) => {
        selectionEnabled = enabled;
        frameScopeOpen = false;
        setWidgetMode(selectionEnabled ? "selecting" : "ready");
      },
      intent,
    );
    if (!synchronized) {
      if (!intent.isCurrent()) return;
      throw new Error(widgetStrings.operationFailed);
    }
  }, intent, () => {
    if (shouldConsumeBasicDiagnostics) consumeBasicDiagnosticsIntent(basicDiagnosticsIntent);
  });
}

async function selectFrameScopeWithLease(
  scope: FrameScopeDescriptor,
  startSelection: boolean,
  intent: WidgetIntentToken,
  basicDiagnosticsIntent: WidgetBasicDiagnosticsIntent | null = null,
): Promise<boolean> {
  try {
    return await frameScopeSelection.select({
      ...scope,
      selectionIntent: intent,
      ...(startSelection && basicDiagnosticsIntent?.enabled === true
        ? { collectBasicDiagnostics: true as const }
        : {}),
    }, startSelection, intent);
  } catch (error) {
    throw new Error(formatFrameScopeAccessError(error));
  }
}

async function stopFrameScopeSelection(intent: WidgetIntentToken): Promise<boolean> {
  try {
    return await frameScopeSelection.stop(intent);
  } catch (error) {
    throw new Error(formatFrameScopeAccessError(error));
  }
}

function formatFrameScopeAccessError(error: unknown): string {
  return formatFrameScopeFailure(
    error instanceof FrameScopeAccessError ? error.code : "FRAME_PERMISSION_UNAVAILABLE",
  );
}

function formatFrameScopeFailure(code: string): string {
  return formatElementSelectionFailureStatus(code, widgetI18n.t);
}

async function refreshBridgeState(): Promise<void> {
  try {
    const response = await sendBoundCommand<unknown>({
      type: "ui-attach:widget-bridge-read-status",
    });
    if (!response.ok || !isBridgeStatus(response.data)) {
      bridgeState = "unavailable";
      bridgeReadAcknowledgementState = "unavailable";
      bridgeExpiresAt = null;
      connectionRequestText = null;
      stopPendingBridgeRefresh();
      return;
    }
    applyBridgeStatus(response.data);
    await refreshWidgetAnnotationLifecycleControlProposal();
  } catch {
    bridgeState = "unavailable";
    bridgeReadAcknowledgementState = "unavailable";
    bridgeExpiresAt = null;
    connectionRequestText = null;
    lifecycleControlProposal = null;
    stopPendingBridgeRefresh();
  }
}

async function refreshWidgetAnnotationLifecycleControlProposal(): Promise<void> {
  if (bridgeState !== "connected") {
    lifecycleControlProposal = null;
    return;
  }
  let response: SessionCommandResponse<unknown>;
  try {
    response = await sendBoundCommand<unknown>({
      type: "ui-attach:widget-lifecycle-control-read-next",
    });
  } catch {
    lifecycleControlProposal = null;
    return;
  }
  if (!response.ok || response.data === null) {
    lifecycleControlProposal = null;
    return;
  }
  const proposal = parseWidgetAnnotationLifecycleControlProposal(response.data);
  if (!proposal || Date.parse(proposal.expiresAt) <= Date.now() || (
    latestSnapshot && !findPanelSessionItem(latestSnapshot.file, proposal.itemId)
  )) {
    lifecycleControlProposal = null;
    return;
  }
  const changed = lifecycleControlProposal?.operationId !== proposal.operationId ||
    lifecycleControlProposal.fingerprint !== proposal.fingerprint;
  lifecycleControlProposal = proposal;
  if (changed) await openWidgetAnnotationLifecycleControlProposal(proposal);
}

async function openWidgetAnnotationLifecycleControlProposal(
  proposal: WidgetAnnotationLifecycleControlProposal,
): Promise<void> {
  if (!annotationSurface || !latestSnapshot ||
      !findPanelSessionItem(latestSnapshot.file, proposal.itemId)) return;
  const opened = await annotationSurface.edit(proposal.itemId).catch(() => false);
  if (opened) view?.focus();
}

async function decideWidgetAnnotationLifecycleControlProposal(
  decision: "approve" | "reject",
  operationId: string,
  fingerprint: string,
  interaction: InPageWidgetInteraction,
): Promise<void> {
  const proposal = lifecycleControlProposal;
  const command = createWidgetAnnotationLifecycleControlDecisionCommand(
    proposal,
    decision,
    operationId,
    fingerprint,
    interaction,
  );
  if (!proposal || !command) return;
  await runAction(async () => {
    setWidgetBusyAction("lifecycle");
    const response = await sendBoundCommand<unknown>(command);
    if (!response.ok) throw new Error(safeMessage(response.error));
    if (lifecycleControlProposal?.operationId !== proposal.operationId ||
        lifecycleControlProposal.fingerprint !== proposal.fingerprint) {
      throw new Error(widgetStrings.operationFailed);
    }
    lifecycleControlProposal = null;
    await Promise.all([
      controller?.refreshActiveOrigin(proposal.itemId) ?? Promise.resolve(),
      refreshBridgeState(),
    ]);
  });
}

async function refreshDisclosureState(): Promise<void> {
  const response = await sendBoundCommand<{ acknowledged: boolean }>({
    type: "ui-attach:widget-disclosure-read",
  });
  if (!response.ok) throw new Error(widgetStrings.disclosureLoadFailed);
  disclosureRequired = !response.data.acknowledged;
}

async function acknowledgeDisclosure(): Promise<void> {
  await runAction(async () => {
    setWidgetBusyAction("disclosure");
    const response = await sendBoundCommand<{ acknowledged: boolean }>({
      type: "ui-attach:widget-disclosure-acknowledge",
    });
    if (!response.ok || !response.data.acknowledged) {
      throw new Error(widgetStrings.disclosureAcknowledgeFailed);
    }
  }, null, () => {
    disclosureRequired = false;
  });
}

async function createInvitation(): Promise<void> {
  let nextBridgeStatus: {
    connected: boolean;
    pending: boolean;
    requestText: string | null;
    expiresAt: string | null;
  } | null = null;
  await runAction(async () => {
    setWidgetBusyAction("connect");
    if (!await chrome.permissions.request({ origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN] })) {
      throw new Error(widgetStrings.operationFailed);
    }
    try {
      const response = await sendBoundCommand<unknown>({
        type: "ui-attach:widget-bridge-create-invitation",
      });
      if (!response.ok) throw new Error(response.error);
      if (!isBridgeStatus(response.data)) throw new Error(widgetStrings.operationFailed);
      nextBridgeStatus = response.data;
    } catch (error) {
      await chrome.permissions.remove({ origins: [LOCAL_AGENT_BRIDGE_PERMISSION_ORIGIN] })
        .catch(() => false);
      throw error;
    }
  }, null, () => {
    if (nextBridgeStatus) applyBridgeStatus(nextBridgeStatus);
  });
}

async function refreshConnection(): Promise<void> {
  let nextBridgeStatus: {
    connected: boolean;
    pending: boolean;
    requestText: string | null;
    expiresAt: string | null;
  } | null = null;
  await runAction(async () => {
    setWidgetBusyAction("refresh");
    stopPendingBridgeRefresh();
    const response = await sendBoundCommand<unknown>({
      type: "ui-attach:widget-bridge-refresh",
    });
    if (!response.ok) throw new Error(response.error);
    if (!isBridgeStatus(response.data)) throw new Error(widgetStrings.operationFailed);
    nextBridgeStatus = response.data;
  }, null, () => {
    if (nextBridgeStatus) applyBridgeStatus(nextBridgeStatus);
  });
}

async function disconnectBridge(): Promise<void> {
  await runAction(async () => {
    setWidgetBusyAction("disconnect");
    stopPendingBridgeRefresh();
    const response = await sendBoundCommand<null>({
      type: "ui-attach:widget-bridge-disconnect",
    });
    if (!response.ok) throw new Error(response.error);
  }, null, () => {
    bridgeState = "disconnected";
    bridgeReadAcknowledgementState = "unavailable";
    bridgeExpiresAt = null;
    connectionRequestText = null;
    lifecycleControlProposal = null;
  });
}

async function copyInvitation(text: string): Promise<void> {
  await runAction(async () => {
    setWidgetBusyAction("copy");
    await navigator.clipboard.writeText(text);
  }, null, () => {
    setWidgetStatus({ kind: "success", message: widgetStrings.invitationCopied });
  });
}

function applyBridgeStatus(value: {
  connected: boolean;
  pending: boolean;
  requestText: string | null;
  expiresAt: string | null;
  sharedTargetCount?: number | null;
  sharedSequence?: number | null;
  readAcknowledgementState?: InPageWidgetReadAcknowledgementState;
}): void {
  const invitationExpired = isExpiredBridgeTransition(
    bridgeState,
    bridgeExpiresAt,
    value,
  );
  bridgeState = value.connected ? "connected" : value.pending ? "pending" : "disconnected";
  bridgeReadAcknowledgementState = value.connected &&
      Number.isSafeInteger(value.sharedSequence) &&
      Number(value.sharedSequence) >= 0 &&
      (value.readAcknowledgementState === "waiting" ||
        value.readAcknowledgementState === "current" ||
        value.readAcknowledgementState === "unavailable")
    ? value.readAcknowledgementState
    : "unavailable";
  if (bridgeState !== "connected") lifecycleControlProposal = null;
  bridgeSharedTargetCount = value.connected && Number.isSafeInteger(value.sharedTargetCount) &&
      Number(value.sharedTargetCount) >= 0
    ? Number(value.sharedTargetCount)
    : null;
  bridgeSharedSequence = value.connected && Number.isSafeInteger(value.sharedSequence) &&
      Number(value.sharedSequence) >= 0
    ? Number(value.sharedSequence)
    : null;
  bridgeExpiresAt = bridgeState === "pending" ? value.expiresAt : null;
  connectionRequestText = value.requestText;
  if (invitationExpired) {
    connectionRequestText = null;
    setWidgetStatus({ kind: "error", message: widgetStrings.invitationExpired });
  }
  if (bridgeState === "pending" || bridgeState === "connected") schedulePendingBridgeRefresh();
  else stopPendingBridgeRefresh();
}

export function pendingBridgeRemainingSeconds(
  expiresAt: string | null,
  nowMs = Date.now(),
): number | null {
  if (expiresAt === null || !Number.isFinite(nowMs)) return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
}

export function isExpiredBridgeTransition(
  previousState: InPageWidgetBridgeState,
  previousExpiresAt: string | null,
  next: { connected: boolean; pending: boolean },
  nowMs = Date.now(),
): boolean {
  return previousState === "pending" && !next.connected && !next.pending &&
    pendingBridgeRemainingSeconds(previousExpiresAt, nowMs) === 0;
}

function schedulePendingBridgeRefresh(): void {
  if (
    shuttingDown || (bridgeState !== "pending" && bridgeState !== "connected") ||
    bridgeRefreshInFlight ||
    bridgeRefreshTimer !== null
  ) return;
  const delayMs = bridgeState === "pending"
    ? PENDING_BRIDGE_REFRESH_DELAY_MS
    : CONNECTED_BRIDGE_STATUS_DELAY_MS;
  bridgeRefreshTimer = window.setTimeout(() => {
    bridgeRefreshTimer = null;
    void refreshPendingBridgeStatus();
  }, delayMs);
}

async function refreshPendingBridgeStatus(): Promise<void> {
  if (
    shuttingDown || (bridgeState !== "pending" && bridgeState !== "connected") ||
    bridgeRefreshInFlight
  ) return;
  if (bridgeState === "pending" && pendingBridgeRemainingSeconds(bridgeExpiresAt) === 0) {
    bridgeState = "disconnected";
    bridgeReadAcknowledgementState = "unavailable";
    bridgeExpiresAt = null;
    connectionRequestText = null;
    stopPendingBridgeRefresh();
    setWidgetStatus({ kind: "error", message: widgetStrings.invitationExpired });
    return;
  }
  bridgeRefreshInFlight = true;
  try {
    const pending = bridgeState === "pending";
    const response = await sendBoundCommand<unknown>({
      type: pending
        ? "ui-attach:widget-bridge-refresh"
        : "ui-attach:widget-bridge-read-status",
    });
    if (response.ok && isBridgeStatus(response.data)) {
      applyBridgeStatus(response.data);
      await refreshWidgetAnnotationLifecycleControlProposal();
    } else {
      bridgeReadAcknowledgementState = "unavailable";
    }
  } catch {
    // Keep the last connection status during a transient owner or worker
    // interruption, but never keep claiming that an ACK is current when it
    // could not be re-read.
    bridgeReadAcknowledgementState = "unavailable";
  } finally {
    bridgeRefreshInFlight = false;
    render();
    schedulePendingBridgeRefresh();
  }
}

function stopPendingBridgeRefresh(): void {
  if (bridgeRefreshTimer === null) return;
  window.clearTimeout(bridgeRefreshTimer);
  bridgeRefreshTimer = null;
}

async function copyAnnotationHandoff(
  detail: AttachmentFeedbackDetail,
  snapshot: PanelSessionSnapshot,
): Promise<AnnotationSurfaceCopyResult> {
  const currentScope = derivePanelCurrentScope(
    snapshot.file,
    snapshot.selectedItemId,
    snapshot.activePage,
    (() => {
      const itemIds = currentWidgetReferenceScopeItemIds(snapshot);
      return itemIds === null ? undefined : new Set(itemIds);
    })(),
  );
  const selected = findPanelSessionItem(snapshot.file, currentScope.selectedItemId);
  const record = selected?.sourceRecord as OriginCaptureRecord | undefined;
  const result = buildPanelAgentCopy({
    file: snapshot.file,
    attachmentIds: currentScope.itemIds,
    selectedItemId: currentScope.selectedItemId,
    selectedRecord: record ?? snapshot.legacyRecord,
    viewMode: "agent_safe",
    intent: snapshot.intent,
    outputDetail: detail,
  });
  if (!result.ok) throw new Error(result.error);
  let copied = true;
  try {
    await navigator.clipboard.writeText(result.text);
  } catch {
    copied = false;
  }
  return {
    copied,
    count: result.attachmentCount,
    text: result.text,
    readback: toPanelAnnotationSurfaceReadback(
      snapshot,
      currentWidgetReferenceScopeItemIds(snapshot),
    ),
  };
}

function disarmClearConfirmation(): void {
  annotationSurface?.disarmClearConfirmation();
}

function currentBasicDiagnosticsIntent(): WidgetBasicDiagnosticsIntent | null {
  const intent = basicDiagnosticsState.snapshot();
  return intent.enabled ? intent : null;
}

function consumeBasicDiagnosticsIntent(intent: WidgetBasicDiagnosticsIntent | null): void {
  if (!intent || !basicDiagnosticsState.consume(intent)) return;
  render();
}

async function runAction(
  action: () => Promise<void>,
  intent: WidgetIntentToken | null = null,
  onSuccess?: () => void,
): Promise<boolean> {
  const actionIntent = widgetActionBarrier.beginIntent();
  const effectiveIntent: WidgetIntentToken = {
    isCurrent: () => actionIntent.isCurrent() && (intent?.isCurrent() ?? true),
  };
  let ownedBusyRevision: number | null = null;
  return await runWidgetIntentAction(() => {
    const before = busyActionRevision;
    const pending = action();
    if (busyActionRevision !== before) ownedBusyRevision = busyActionRevision;
    return pending;
  }, effectiveIntent, {
    onStart: () => setWidgetStatus(null),
    // Async action callbacks set their busy state before the first await. Paint
    // that state immediately so native-host startup and bridge requests never
    // look like an ignored click while their promise is still pending.
    onRender: render,
    onError: (error) => setWidgetStatus({
      kind: "error",
      message: error instanceof Error ? safeMessage(error.message) : widgetStrings.operationFailed,
    }),
    onSuccess,
    onFinally: (current) => {
      if (ownedBusyRevision !== null) {
        if (busyActionRevision === ownedBusyRevision) setWidgetBusyAction(null);
        return;
      }
      if (current) setWidgetBusyAction(null);
    },
  });
}

async function runSelectionAction(
  intent: WidgetIntentToken,
  action: () => Promise<void>,
  onSuccess?: () => void,
): Promise<boolean> {
  return await runAction(async () => {
    setWidgetBusyAction("selection");
    await selectionActionQueue.enqueue(async () => {
      if (!intent.isCurrent()) return;
      await action();
    });
  }, intent, onSuccess);
}

export function projectWidgetRecoveryDraft(snapshot: Pick<PanelSessionSnapshot, "recovery">): string | null {
  return snapshot.recovery?.intent ?? null;
}

function render(): void {
  if (!view || !latestSnapshot) return;
  const annotationState = annotationSurface?.getSnapshot();
  const rows = summarizePanelSessionRows(
    latestSnapshot.file,
    latestSnapshot.selectedItemId,
    "agent_safe",
    latestSnapshot.activePage,
  );
  const selected = rows.find((row) => row.id === latestSnapshot!.selectedItemId) ?? null;
  const projectedStatus = projectInPageWidgetStatus(
    { value: annotationStatus, revision: annotationStatusRevision },
    { value: status, revision: localStatusRevision },
    {
      snapshot: latestSnapshot,
      activeItemId: annotationState?.activeItemId ?? latestSnapshot.selectedItemId,
      strings: widgetStrings,
    },
  );
  const pageTargetCount = currentWidgetPageItemIds(latestSnapshot)?.length ?? 0;
  const siteTargetCount = currentWidgetSiteItemIds(latestSnapshot)?.length ?? pageTargetCount;
  view.update({
    mode: annotationState?.mode ?? mode,
    selectionEnabled,
    readiness: annotationState?.readiness ?? "hydrating",
    bridgeState,
    bridgeInvitationRemainingSeconds: bridgeState === "pending"
      ? pendingBridgeRemainingSeconds(bridgeExpiresAt)
      : null,
    bridgeSharedTargetCount,
    bridgeSharedSequence,
    bridgeReadAcknowledgementState,
    disclosureRequired,
    clearConfirmationRequired:
      annotationState?.clearConfirmationRequired ?? pendingClearConfirmation,
    clearStatus: annotationState
      ? projectInPageWidgetClearStatus(annotationState as ClearAwareAnnotationSurfaceSnapshot)
      : undefined,
    connectionRequestText,
    manualCopyText: annotationState?.manualCopyText ??
      privateDebugSummaryManualCopy?.text ?? manualCopyText,
    outputDetail: annotationState?.outputDetail ?? outputDetail,
    displayMode: overlayDisplayMode,
    collectBasicDiagnosticsForNextCapture: basicDiagnosticsState.snapshot().enabled,
    basicDiagnosticsCommandRevision,
    privateDebugSummary: projectWidgetPrivateDebugSummary(latestSnapshot.metadataDiagnostics),
    privateDebugSummaryCopied:
      copiedPrivateDebugSummaryBinding !== null &&
      copiedPrivateDebugSummaryBinding === widgetPrivateDebugSummaryBinding(
        latestSnapshot.metadataDiagnostics,
      ),
    referenceScope,
    pageTargetCount,
    siteTargetCount,
    siteLabel: currentWidgetSiteLabel(latestSnapshot),
    frameScopeOpen,
    frameScopes: frameScopes.map((scope) => ({
      id: frameScopeId(scope),
      kind: scope.frameId === 0 ? "top" : "embedded",
      detail: `${scope.origin}${scope.pathname}`,
      depth: scope.depth,
      current: scope.frameId === currentFrameId,
      selectable: scope.selectable,
      itemCount: scope.itemCount,
    })),
    targets: annotationState?.items.map(({ itemId, label, name, annotationLifecycle }) => ({
      itemId,
      label,
      name,
      annotationLifecycle: annotationLifecycle ? { ...annotationLifecycle } : null,
    })) ?? rows.map((row) => ({ itemId: row.id, label: row.label, name: row.target })),
    lifecycleControlProposal: projectWidgetAnnotationLifecycleControlProposal(
      lifecycleControlProposal,
    ),
    activeItemId: annotationState?.activeItemId ?? latestSnapshot.selectedItemId,
    taskNote: annotationState?.taskNote ?? latestSnapshot.intent,
    recoveryDraft: projectWidgetRecoveryDraft(latestSnapshot),
    shortcuts: selected && rows.length > 1
      ? [{
          id: "below",
          label: widgetStrings.shortcutBelow,
          note: widgetStrings.shortcutBelowNote(selected.label),
        }]
      : [],
    busyAction: projectInPageWidgetBusyAction(annotationState?.busyAction, busyAction),
    status: projectedStatus,
  } as InPageWidgetViewModel & { clearStatus?: InPageWidgetClearStatus });
  if (authenticatedUiReady) {
    postLayout(resolveWidgetLayout());
  }
}

async function refreshOverlayDisplayMode(): Promise<void> {
  displayPreferenceCoordinator.externalChange();
  await displayPreferenceCoordinator.drain();
}

function handleDisplayPreferenceStorageChange(
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
): void {
  if (areaName !== "local" || !("ui-attach:overlay-display-mode" in changes)) return;
  displayPreferenceCoordinator.externalChange();
}

function queueOverlayDisplayModeWrite(nextMode: PersistentOverlayDisplayMode): void {
  displayPreferenceCoordinator.request(nextMode);
}

function handleRuntimeMessage(message: unknown): boolean {
  const sessionContextChanged = isRecord(message) && (
    message.type === UI_ATTACH_SESSION_UPDATED ||
    message.type === UI_ATTACH_ACTIVE_ORIGIN_CHANGED
  );
  const overlayProjectionChanged = isRecord(message) &&
    message.type === UI_ATTACH_OVERLAY_PROJECTION_UPDATED;
  if ((sessionContextChanged || overlayProjectionChanged) && busyAction !== "frame-scope") {
    const intent = selectionIntentBarrier.snapshot();
    void Promise.allSettled([
      sessionContextChanged || overlayProjectionChanged
        ? controller?.refreshActiveOrigin() ?? Promise.resolve()
        : Promise.resolve(),
      refreshFrameScopes(intent),
      sessionContextChanged ? refreshBridgeState() : Promise.resolve(),
    ]).then(() => {
      if (!shuttingDown) render();
    });
  }
  if (isRecord(message) && message.type === UI_ATTACH_ELEMENT_SELECTION_UPDATED) {
    const explicitlyDisabled = message.enabled === false;
    const intent = shouldRotateSelectionIntentForRuntimeUpdate(
        message.enabled,
        mode,
      )
      ? selectionIntentBarrier.beginIntent()
      : selectionIntentBarrier.snapshot();
    if (explicitlyDisabled) {
      selectionEnabled = false;
      selectionResumeAllowed = false;
      if (mode === "ready" || mode === "selecting") setWidgetMode("ready");
    }
    void Promise.all([refreshSelectionState(intent), refreshFrameScopes(intent)]).then(async () => {
      if (!intent.isCurrent()) return;
      if (explicitlyDisabled && !selectionEnabled) {
        await frameScopeSelection.releasePermission();
      }
      if (!intent.isCurrent()) return;
      if (mode === "ready" || mode === "selecting") {
        setWidgetMode(selectionEnabled ? "selecting" : "ready");
      }
      render();
    }).catch(async () => {
      const applied = await settleWidgetIntentFailure(intent, async () => undefined, () => {
        selectionEnabled = false;
        if (mode === "ready" || mode === "selecting") setWidgetMode("ready");
        setWidgetStatus({ kind: "error", message: widgetStrings.operationFailed });
      });
      if (applied) render();
    });
  }
  return false;
}

function resetAuthenticatedUi(
  candidate: InPageWidgetInitMessage,
  port: MessagePort,
): void {
  authenticatedUiReady = false;
  stopPendingBridgeRefresh();
  if (runtimeMessageListening) {
    chrome.runtime.onMessage.removeListener?.(handleRuntimeMessage);
    runtimeMessageListening = false;
  }
  if (displayPreferenceListening) {
    chrome.storage.onChanged.removeListener?.(handleDisplayPreferenceStorageChange);
    displayPreferenceListening = false;
  }
  stopControllerSubscription?.();
  stopControllerSubscription = null;
  annotationSurface?.dispose();
  annotationSurface = null;
  view?.dispose();
  view = null;
  controller = null;
  latestSnapshot = null;
  root.replaceChildren();
  if (privatePort === port) privatePort = null;
  if (init?.surfaceId === candidate.surfaceId && init.capability === candidate.capability) {
    init = null;
  }
  selectionEnabled = false;
  referenceScope = "page";
  basicDiagnosticsState.setEnabled(false);
  basicDiagnosticsCommandRevision = 0;
  frameScopeOpen = false;
  currentFrameId = 0;
  frameScopes = [];
  disclosureRequired = true;
  bridgeState = "disconnected";
  bridgeReadAcknowledgementState = "unavailable";
  lifecycleControlProposal = null;
  bridgeExpiresAt = null;
  connectionRequestText = null;
  manualCopyText = null;
  privateDebugSummaryManualCopy = null;
  privateDebugSummaryFailureStatusBinding = null;
  copiedPrivateDebugSummaryBinding = null;
  mode = "collapsed";
  status = null;
  busyActionRevision += 1;
  busyAction = null;
  annotationBusyAction = null;
  annotationStatus = null;
  const resetStatusRevision = ++statusRevision;
  localStatusRevision = resetStatusRevision;
  annotationStatusRevision = resetStatusRevision;
  widgetActionBarrier.beginIntent();
  pendingClearConfirmation = false;
  window.addEventListener("message", handlePrivateConnect);
}

function resolveWidgetLayout(): "collapsed" | "workbar" | "scope" | "expanded" {
  const projectedStatus = projectInPageWidgetStatus(
    { value: annotationStatus, revision: annotationStatusRevision },
    { value: status, revision: localStatusRevision },
    {
      snapshot: latestSnapshot,
      activeItemId: annotationSurface?.getSnapshot().activeItemId ?? latestSnapshot?.selectedItemId ?? null,
      strings: widgetStrings,
    },
  );
  const effectiveManualCopyText = annotationSurface?.getSnapshot().manualCopyText ??
    privateDebugSummaryManualCopy?.text ?? manualCopyText;
  if (mode === "collapsed") return "collapsed";
  if (frameScopeOpen && !disclosureRequired && mode !== "details" && mode !== "editing" &&
      effectiveManualCopyText === null && projectedStatus?.kind !== "error") return "scope";
  return disclosureRequired || mode === "details" || mode === "editing" ||
      effectiveManualCopyText !== null || projectedStatus?.kind === "error"
    ? "expanded"
    : "workbar";
}

function postLayout(nextMode: "collapsed" | "workbar" | "scope" | "expanded"): void {
  try {
    privatePort?.postMessage(nextMode === "workbar"
      ? {
        type: "meanthis.widget.layout",
        mode: nextMode,
        width: measureWorkbarWidth(),
      }
      : nextMode === "scope"
      ? {
          type: "meanthis.widget.layout",
          mode: nextMode,
          ...measureScopeLayout(),
        }
      : { type: "meanthis.widget.layout", mode: nextMode });
  } catch {
    // The page host will fail closed if its private channel is no longer available.
  }
}

function measureScopeLayout(): { width: number; height: number } {
  const panel = view?.element.querySelector<HTMLElement>(
    '.meanthis-panel[data-layout="scope"]',
  );
  const rect = panel?.getBoundingClientRect();
  const measuredWidth = panel ? Math.max(rect?.width ?? 0, panel.scrollWidth) : 0;
  const measuredHeight = panel ? Math.max(rect?.height ?? 0, panel.scrollHeight) : 0;
  return {
    width: Number.isFinite(measuredWidth) && measuredWidth > 0
      ? Math.min(480, Math.max(240, Math.ceil(measuredWidth)))
      : 360,
    height: Number.isFinite(measuredHeight) && measuredHeight > 0
      ? Math.min(344, Math.max(128, Math.ceil(measuredHeight)))
      : 224,
  };
}

function measureWorkbarWidth(): number {
  const panel = view?.element.querySelector<HTMLElement>(
    '.meanthis-panel[data-layout="workbar"]',
  );
  const measured = panel
    ? Math.max(panel.getBoundingClientRect().width, panel.scrollWidth)
    : 0;
  if (!Number.isFinite(measured) || measured <= 0) return 292;
  return Math.min(480, Math.max(200, Math.ceil(measured)));
}

function receiveOverlayAction(action: InPageWidgetActionMessage): void {
  overlayActionConsumer.receive(action);
}

window.addEventListener("pagehide", () => {
  shuttingDown = true;
  disarmClearConfirmation();
  stopPendingBridgeRefresh();
  if (lifecycleReconnectTimer !== null) window.clearTimeout(lifecycleReconnectTimer);
  lifecycleReconnectTimer = null;
  void (selectionEnabled
    ? frameScopeSelection.stop()
    : frameScopeSelection.releasePermission()).catch(() => undefined);
  dispatchInPageWidgetLifecycleExit("document-pagehide", {
    disconnectLifecycle: () => lifecyclePort?.disconnect(),
    releaseSurface: () => {
      void sendBoundCommand<null>({ type: "ui-attach:widget-surface-release" })
        .catch(() => undefined);
    },
  });
  lifecyclePort = null;
  lifecycleSurfaceId = null;
  if (runtimeMessageListening) {
    chrome.runtime.onMessage.removeListener?.(handleRuntimeMessage);
    runtimeMessageListening = false;
  }
  stopControllerSubscription?.();
  stopControllerSubscription = null;
  annotationSurface?.dispose();
  annotationSurface = null;
  view?.dispose();
  privatePort?.close();
  privatePort = null;
}, { once: true });

function requireSnapshot(): PanelSessionSnapshot {
  if (!latestSnapshot) throw new Error(widgetStrings.sessionNotReady);
  return latestSnapshot;
}

function isRegisteredResponse(value: unknown): boolean {
  return isRecord(value) && value.ok === true && isRecord(value.data) &&
    value.data.registered === true;
}

function isCommandResponse<T>(value: unknown): value is SessionCommandResponse<T> {
  return isRecord(value) && typeof value.ok === "boolean" &&
    (value.ok ? Object.hasOwn(value, "data") :
      typeof value.code === "string" && typeof value.error === "string");
}

function isBridgeStatus(value: unknown): value is {
  connected: boolean;
  pending: boolean;
  requestText: string | null;
  expiresAt: string | null;
  sharedTargetCount?: number | null;
  sharedSequence?: number | null;
  readAcknowledgementState?: InPageWidgetReadAcknowledgementState;
} {
  return isRecord(value) && typeof value.connected === "boolean" &&
    typeof value.pending === "boolean" &&
    (value.expiresAt === null || (
      typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    )) &&
    (value.requestText === null || (
      typeof value.requestText === "string" && value.requestText.length <= 1_024
    )) &&
    (!Object.hasOwn(value, "sharedTargetCount") || value.sharedTargetCount === null ||
      isNonNegativeInteger(value.sharedTargetCount)) &&
    (!Object.hasOwn(value, "sharedSequence") || value.sharedSequence === null ||
      isNonNegativeInteger(value.sharedSequence)) &&
    (!Object.hasOwn(value, "readAcknowledgementState") ||
      value.readAcknowledgementState === "waiting" ||
      value.readAcknowledgementState === "current" ||
      value.readAcknowledgementState === "unavailable");
}

export function parseWidgetFrameScopeListData(value: unknown): {
  currentFrameId: number;
  scopes: WidgetFrameScopeDescriptor[];
} | null {
  if (!isRecord(value) || !hasExactKeys(value, ["currentFrameId", "scopes"]) ||
      !isNonNegativeInteger(value.currentFrameId) || !Array.isArray(value.scopes) ||
      value.scopes.length < 1 || value.scopes.length > 256) return null;
  const scopes: WidgetFrameScopeDescriptor[] = [];
  for (const rawScope of value.scopes) {
    const scope = parseWidgetFrameScope(rawScope);
    if (!scope) return null;
    scopes.push(scope);
  }
  const byId = new Map(scopes.map((scope) => [scope.frameId, scope]));
  if (byId.size !== scopes.length) return null;
  const rootScope = byId.get(0);
  const currentScope = byId.get(value.currentFrameId);
  if (!rootScope || rootScope.parentFrameId !== null || rootScope.depth !== 0 ||
      !rootScope.selectable || !currentScope) return null;
  for (const scope of scopes) {
    if (scope.frameId === 0) continue;
    const parent = scope.parentFrameId === null ? undefined : byId.get(scope.parentFrameId);
    if (!parent || scope.depth !== parent.depth + 1) return null;
  }
  return { currentFrameId: value.currentFrameId, scopes };
}

function parseWidgetFrameScope(value: unknown): WidgetFrameScopeDescriptor | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "frameId",
    "parentFrameId",
    "documentId",
    "origin",
    "pathname",
    "depth",
    "requiresHostPermission",
    "selectable",
    "itemCount",
    "itemIds",
  ]) || !isNonNegativeInteger(value.frameId) ||
      !(value.parentFrameId === null || isNonNegativeInteger(value.parentFrameId)) ||
      !(value.documentId === null || isBoundedIdentifier(value.documentId, 256)) ||
      !isCanonicalHttpOrigin(value.origin) || !isCanonicalPathname(value.pathname, value.origin) ||
      !isNonNegativeInteger(value.depth) || value.depth > 32 ||
      typeof value.requiresHostPermission !== "boolean" || typeof value.selectable !== "boolean" ||
      !(value.itemCount === null || (
        isNonNegativeInteger(value.itemCount) && value.itemCount <= 26
      )) ||
      !(value.itemIds === null || (
        Array.isArray(value.itemIds) &&
        value.itemIds.length <= 26 &&
        value.itemIds.every((itemId) => isBoundedIdentifier(itemId, 256)) &&
        new Set(value.itemIds).size === value.itemIds.length
      )) ||
      (value.itemIds === null) !== (value.itemCount === null) ||
      (Array.isArray(value.itemIds) && value.itemCount !== value.itemIds.length) ||
      (value.frameId > 0 && value.selectable && value.documentId === null)) return null;
  return {
    frameId: value.frameId,
    parentFrameId: value.parentFrameId,
    documentId: value.documentId,
    origin: value.origin,
    pathname: value.pathname,
    depth: value.depth,
    requiresHostPermission: value.requiresHostPermission,
    selectable: value.selectable,
    itemCount: value.itemCount,
    itemIds: value.itemIds === null ? null : [...value.itemIds],
  };
}

function frameScopeId(scope: FrameScopeDescriptor): string {
  return `frame-${scope.frameId}`;
}

function isSelectionState(value: unknown): value is { enabled: boolean } {
  return isRecord(value) && hasExactKeys(value, ["enabled"]) && typeof value.enabled === "boolean";
}

export function isWidgetSelectionState(value: unknown): value is WidgetSelectionState {
  return isRecord(value) && hasExactKeys(value, [
    "enabled",
    "generation",
    "resumeAllowed",
  ]) && typeof value.enabled === "boolean" && isNonNegativeInteger(value.generation) &&
    typeof value.resumeAllowed === "boolean";
}

function applyWidgetSelectionState(value: WidgetSelectionState): void {
  selectionEnabled = value.enabled;
  selectionAuthorityGeneration = value.generation;
  selectionResumeAllowed = value.resumeAllowed;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, origin: string): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  try {
    const url = new URL(value, `${origin}/`);
    return url.origin === origin && url.pathname === value && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readExactWidgetDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expected.length || keys.some((key) =>
      typeof key !== "string" || !expected.includes(key)
    )) return null;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") ||
          descriptor.value === undefined) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 180) ||
    widgetStrings.operationFailed;
}

function normalizeWidgetLanguage(value: string): string {
  const normalized = value.replace(/_/gu, "-").trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(normalized) ? normalized : "en";
}
