// @vitest-environment jsdom

import { beforeAll, describe, expect, test, vi } from "vitest";
import type { MetadataDiagnosticsV1 } from "@meanthis/schema";
import {
  UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
  type InPageWidgetActionMessage,
} from "./in-page-widget-contract";
import type { SessionCommandResponse } from "./messages";

const SURFACE_ID = "123e4567-e89b-42d3-a456-426614174000";
const ACTION_ID = "3c9e713d-63d3-42f0-a190-c8f4af77dfd2";

type ActionConsumerFactory = typeof import("./in-page-widget-entry")["createInPageWidgetActionConsumer"];
type ProductionMoreConsumer = typeof import("./in-page-widget-entry")["consumeInPageWidgetMore"];
type LifecycleExitDispatcher = typeof import("./in-page-widget-entry")["dispatchInPageWidgetLifecycleExit"];
type RegistrationFailurePhase = typeof import("./in-page-widget-entry")["registrationFailurePhase"];
type OpenFullSidePanelFromWidgetInteraction =
  typeof import("./in-page-widget-entry")["openFullSidePanelFromWidgetInteraction"];
type BasicDiagnosticsStateFactory =
  typeof import("./in-page-widget-entry")["createWidgetBasicDiagnosticsState"];
type SelectionSetCommandFactory =
  typeof import("./in-page-widget-entry")["createWidgetSelectionSetCommand"];
type BasicDiagnosticsSetCommandFactory =
  typeof import("./in-page-widget-entry")["createWidgetBasicDiagnosticsSetCommand"];
type SelectionActionQueueFactory =
  typeof import("./in-page-widget-entry")["createWidgetSelectionActionQueue"];
type CommandFailureCodeNormalizer =
  typeof import("./in-page-widget-entry")["normalizeWidgetCommandFailureCode"];

let createInPageWidgetActionConsumer: ActionConsumerFactory;
let projectWidgetRecoveryDraft: typeof import("./in-page-widget-entry")["projectWidgetRecoveryDraft"];
let consumeInPageWidgetMore: ProductionMoreConsumer;
let dispatchInPageWidgetLifecycleExit: LifecycleExitDispatcher;
let registrationFailurePhase: RegistrationFailurePhase;
let openFullSidePanelFromWidgetInteraction: OpenFullSidePanelFromWidgetInteraction;
let createWidgetBasicDiagnosticsState: BasicDiagnosticsStateFactory;
let createWidgetSelectionSetCommand: SelectionSetCommandFactory;
let createWidgetBasicDiagnosticsSetCommand: BasicDiagnosticsSetCommandFactory;
let createWidgetSelectionActionQueue: SelectionActionQueueFactory;
let normalizeWidgetCommandFailureCode: CommandFailureCodeNormalizer;
let createSelectionIntentBarrier: () => {
  beginIntent(): { isCurrent(): boolean };
  snapshot(): { isCurrent(): boolean };
};
let isWidgetSelectionState: typeof import("./in-page-widget-entry")["isWidgetSelectionState"];
let synchronizeWidgetSelectionAuthority: typeof import("./in-page-widget-entry")["synchronizeWidgetSelectionAuthority"];
let synchronizeWidgetFrameScopes: typeof import("./in-page-widget-entry")["synchronizeWidgetFrameScopes"];
let createWidgetFrameScopeRefreshDrain:
  typeof import("./in-page-widget-entry")["createWidgetFrameScopeRefreshDrain"];
let synchronizeWidgetFrameScopeContext:
  typeof import("./in-page-widget-entry")["synchronizeWidgetFrameScopeContext"];
let initializeWidgetCoreWithDeferredFrameScopes:
  typeof import("./in-page-widget-entry")["initializeWidgetCoreWithDeferredFrameScopes"];
let parseWidgetFrameScopeListData:
  typeof import("./in-page-widget-entry")["parseWidgetFrameScopeListData"];
let resolveWidgetPageItemIds:
  typeof import("./in-page-widget-entry")["resolveWidgetPageItemIds"];
let settleWidgetIntentFailure: typeof import("./in-page-widget-entry")["settleWidgetIntentFailure"];
let runWidgetIntentAction: typeof import("./in-page-widget-entry")["runWidgetIntentAction"];
let projectInPageWidgetBusyAction: typeof import("./in-page-widget-entry")["projectInPageWidgetBusyAction"];
let projectInPageWidgetStatus: typeof import("./in-page-widget-entry")["projectInPageWidgetStatus"];
let collapseWidgetSurface: typeof import("./in-page-widget-entry")["collapseWidgetSurface"];
let shouldRotateSelectionIntentForRuntimeUpdate:
  typeof import("./in-page-widget-entry")["shouldRotateSelectionIntentForRuntimeUpdate"];
let pendingBridgeRemainingSeconds:
  typeof import("./in-page-widget-entry")["pendingBridgeRemainingSeconds"];
let isExpiredBridgeTransition:
  typeof import("./in-page-widget-entry")["isExpiredBridgeTransition"];
let projectInPageWidgetClearStatus: (
  snapshot: { clearStatus: { clearState: "idle"; operationId: null } |
    { clearState: "pending"; operationId: string } },
) => { clearState: "idle"; operationId: null } | { clearState: "pending"; operationId: string };
let parseWidgetAnnotationLifecycleControlProposal:
  typeof import("./in-page-widget-entry")["parseWidgetAnnotationLifecycleControlProposal"];
let projectWidgetAnnotationLifecycleControlProposal:
  typeof import("./in-page-widget-entry")["projectWidgetAnnotationLifecycleControlProposal"];
let createWidgetAnnotationLifecycleControlDecisionCommand:
  typeof import("./in-page-widget-entry")["createWidgetAnnotationLifecycleControlDecisionCommand"];
let projectWidgetPrivateDebugSummary:
  typeof import("./in-page-widget-entry")["projectWidgetPrivateDebugSummary"];
let copyWidgetPrivateDebugSummary:
  typeof import("./in-page-widget-entry")["copyWidgetPrivateDebugSummary"];
let reconcileWidgetPrivateDebugSummaryManualCopy:
  typeof import("./in-page-widget-entry")["reconcileWidgetPrivateDebugSummaryManualCopy"];
let reconcileWidgetPrivateDebugSummaryStatusBinding:
  typeof import("./in-page-widget-entry")["reconcileWidgetPrivateDebugSummaryStatusBinding"];

beforeAll(async () => {
  document.body.innerHTML = '<main id="meanthis-widget-root"></main>';
  vi.stubGlobal("chrome", {
    i18n: {
      getMessage: vi.fn(() => ""),
      getUILanguage: vi.fn(() => "en"),
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => true),
    },
    runtime: {
      connect: vi.fn(),
      sendMessage: vi.fn(async () => undefined),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
  const entry = await import("./in-page-widget-entry");
  projectWidgetRecoveryDraft = entry.projectWidgetRecoveryDraft;
  ({
    createInPageWidgetActionConsumer,
    consumeInPageWidgetMore,
    dispatchInPageWidgetLifecycleExit,
    isWidgetSelectionState,
    projectInPageWidgetBusyAction,
    projectInPageWidgetStatus,
    collapseWidgetSurface,
    shouldRotateSelectionIntentForRuntimeUpdate,
    pendingBridgeRemainingSeconds,
    isExpiredBridgeTransition,
    registrationFailurePhase,
    openFullSidePanelFromWidgetInteraction,
    createWidgetBasicDiagnosticsState,
    createWidgetBasicDiagnosticsSetCommand,
    createWidgetSelectionActionQueue,
    createWidgetSelectionSetCommand,
    normalizeWidgetCommandFailureCode,
    runWidgetIntentAction,
    settleWidgetIntentFailure,
    synchronizeWidgetFrameScopes,
    createWidgetFrameScopeRefreshDrain,
    synchronizeWidgetFrameScopeContext,
    initializeWidgetCoreWithDeferredFrameScopes,
    parseWidgetFrameScopeListData,
    resolveWidgetPageItemIds,
    synchronizeWidgetSelectionAuthority,
    parseWidgetAnnotationLifecycleControlProposal,
    projectWidgetAnnotationLifecycleControlProposal,
    createWidgetAnnotationLifecycleControlDecisionCommand,
    projectWidgetPrivateDebugSummary,
    copyWidgetPrivateDebugSummary,
    reconcileWidgetPrivateDebugSummaryManualCopy,
    reconcileWidgetPrivateDebugSummaryStatusBinding,
  } = entry);
  projectInPageWidgetClearStatus = (
    entry as unknown as { projectInPageWidgetClearStatus: typeof projectInPageWidgetClearStatus }
  ).projectInPageWidgetClearStatus;
  createSelectionIntentBarrier = (
    entry as unknown as { createSelectionIntentBarrier: typeof createSelectionIntentBarrier }
  ).createSelectionIntentBarrier;
});

test("keeps development command failure diagnostics code-only and bounded", () => {
  expect(normalizeWidgetCommandFailureCode("WIDGET_STATE_UNAVAILABLE")).toBe(
    "WIDGET_STATE_UNAVAILABLE",
  );
  expect(normalizeWidgetCommandFailureCode("secret-token")).toBe("UNKNOWN");
  expect(normalizeWidgetCommandFailureCode(`A${"B".repeat(64)}`)).toBe("UNKNOWN");
});

describe("widget recovery projection", () => {
  test("projects the removed target's full draft independently of canonical target state", () => {
    const recovery = { oldOrigin: "https://example.test", oldEpoch: "epoch", itemId: "removed",
      intent: "  Full draft\n中文\nlast line  ", pendingOrigin: "https://example.test" };
    expect(projectWidgetRecoveryDraft({ recovery })).toBe(recovery.intent);
    expect(projectWidgetRecoveryDraft({ recovery: null })).toBeNull();
  });
});

describe("in-page widget private troubleshooting summary", () => {
  const diagnostics = (): MetadataDiagnosticsV1 => ({
    schemaVersion: "0.1.0",
    kind: "ui-attach.metadata-only-diagnostics",
    captureId: "session-opaque-1",
    scope: "capture",
    observedAt: "2026-09-02T12:00:00.000Z",
    consent: "explicit_capture",
    authority: "capture_time",
    replay: {
      status: "collected",
      attemptCount: 2,
      verifiedCount: 1,
      ambiguousCount: 1,
      missingCount: 0,
    },
    device: {
      status: "collected",
      deviceClass: "desktop",
      viewportClass: "large",
      touch: "none",
    },
    network: { status: "not_requested" },
    console: { status: "not_requested" },
    executionAuthority: {
      grantedByCapture: false,
      browserControl: false,
      liveDomMutation: false,
    },
  });

  test("projects no identity, time, source, network, or console fields", () => {
    const summary = projectWidgetPrivateDebugSummary(diagnostics());
    expect(summary).toMatchObject({
      kind: "ui-attach.private-debug-summary",
      scope: "one_capture",
      consent: "explicit_one_shot",
      replay: { verifiedCount: 1, ambiguousCount: 1, missingCount: 0 },
      device: { deviceClass: "desktop", viewportClass: "large", touch: "none" },
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    });
    const text = JSON.stringify(summary);
    for (const forbidden of [
      "session-opaque-1",
      "2026-09-02",
      "network",
      "console",
      "origin",
      "url",
    ]) expect(text).not.toContain(forbidden);
  });

  test("writes only after a trusted copy action and returns bounded manual fallback text", async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyWidgetPrivateDebugSummary(
      { isTrusted: false },
      diagnostics(),
      writeText,
    )).resolves.toBeNull();
    expect(writeText).not.toHaveBeenCalled();

    const copied = await copyWidgetPrivateDebugSummary(
      { isTrusted: true },
      diagnostics(),
      writeText,
    );
    expect(copied).toMatchObject({ copied: true });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toBe(copied?.text);

    const rejectedWrite = vi.fn(async () => {
      throw new Error("clipboard unavailable");
    });
    const manual = await copyWidgetPrivateDebugSummary(
      { isTrusted: true },
      diagnostics(),
      rejectedWrite,
    );
    expect(manual).toMatchObject({ copied: false });
    expect(manual?.text).toContain("ui-attach.private-debug-summary");
    expect(manual?.text).not.toContain("session-opaque-1");
  });

  test("drops failed-copy fallback and status when the exact diagnostics binding changes", () => {
    const captureABinding = "session-opaque-a\u00002026-09-02T01:02:03.000Z";
    const fallback = {
      binding: captureABinding,
      text: "capture-a-private-summary",
    };

    expect(reconcileWidgetPrivateDebugSummaryManualCopy(
      fallback,
      captureABinding,
    )).toBe(fallback);
    expect(reconcileWidgetPrivateDebugSummaryManualCopy(
      fallback,
      "session-opaque-b\u00002026-09-02T01:03:04.000Z",
    )).toBeNull();
    expect(reconcileWidgetPrivateDebugSummaryManualCopy(fallback, null)).toBeNull();
    expect(reconcileWidgetPrivateDebugSummaryStatusBinding(
      captureABinding,
      captureABinding,
    )).toBe(captureABinding);
    expect(reconcileWidgetPrivateDebugSummaryStatusBinding(
      captureABinding,
      "session-opaque-b\u00002026-09-02T01:03:04.000Z",
    )).toBeNull();
    expect(reconcileWidgetPrivateDebugSummaryStatusBinding(captureABinding, null)).toBeNull();
  });

  test("fails closed without writing for absent, stale-authority, or content-bearing input", async () => {
    const writeText = vi.fn(async () => undefined);
    for (const candidate of [
      null,
      { ...diagnostics(), authority: "live_page" },
      { ...diagnostics(), url: "https://secret.example.test" },
      {
        ...diagnostics(),
        console: { status: "collected", logCount: 1, warnCount: 0, errorCount: 0, windowMs: 1 },
      },
    ]) {
      await expect(copyWidgetPrivateDebugSummary(
        { isTrusted: true },
        candidate,
        writeText,
      )).resolves.toBeNull();
    }
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("in-page widget Agent lifecycle control binding", () => {
  const operationId = "3c9e713d-63d3-4f0a-a190-c8f4af77dfd2";
  const fingerprint = "a".repeat(64);
  const proposal = () => ({
    itemId: "att_control",
    label: "Reference heading",
    operationId,
    fingerprint,
    expectedState: "open" as const,
    nextState: "resolved" as const,
    expiresAt: "2027-09-01T04:00:00.000Z",
    reference: {
      operationId,
      fingerprint,
      ownerGeneration: 7,
      connectionGeneration: 9,
    },
  });

  test("parses one exact proposal and creates only a trusted exact decision command", () => {
    const parsed = parseWidgetAnnotationLifecycleControlProposal(proposal());
    expect(parsed).toEqual(proposal());
    expect(createWidgetAnnotationLifecycleControlDecisionCommand(
      parsed,
      "approve",
      operationId,
      fingerprint,
      { isTrusted: true },
    )).toEqual({
      type: "ui-attach:widget-lifecycle-control-approve",
      reference: proposal().reference,
      userActivation: true,
    });
    expect(createWidgetAnnotationLifecycleControlDecisionCommand(
      parsed,
      "reject",
      operationId,
      fingerprint,
      { isTrusted: true },
    )).toEqual({
      type: "ui-attach:widget-lifecycle-control-reject",
      reference: proposal().reference,
      userActivation: true,
    });
    expect(createWidgetAnnotationLifecycleControlDecisionCommand(
      parsed,
      "approve",
      operationId,
      fingerprint,
      { isTrusted: false },
    )).toBeNull();
    expect(createWidgetAnnotationLifecycleControlDecisionCommand(
      parsed,
      "approve",
      operationId,
      "b".repeat(64),
      { isTrusted: true },
    )).toBeNull();
  });

  test("fails closed on extra, own undefined, or malformed proposal/reference bindings", () => {
    expect(parseWidgetAnnotationLifecycleControlProposal({
      ...proposal(),
      extra: true,
    })).toBeNull();
    expect(parseWidgetAnnotationLifecycleControlProposal({
      ...proposal(),
      label: undefined,
    })).toBeNull();
    expect(parseWidgetAnnotationLifecycleControlProposal({
      ...proposal(),
      operationId: "5a15a1be-fd5e-420b-922f-6cb72f44bf8f",
    })).toBeNull();
    expect(parseWidgetAnnotationLifecycleControlProposal({
      ...proposal(),
      nextState: "open",
    })).toBeNull();
  });

  test("does not invoke top-level or nested accessors", () => {
    const topGetter = vi.fn(() => "att_control");
    const top = proposal() as Record<string, unknown>;
    Object.defineProperty(top, "itemId", { enumerable: true, get: topGetter });
    expect(parseWidgetAnnotationLifecycleControlProposal(top)).toBeNull();
    expect(topGetter).not.toHaveBeenCalled();

    const nestedGetter = vi.fn(() => operationId);
    const reference = proposal().reference as Record<string, unknown>;
    Object.defineProperty(reference, "operationId", {
      enumerable: true,
      get: nestedGetter,
    });
    expect(parseWidgetAnnotationLifecycleControlProposal({
      ...proposal(),
      reference,
    })).toBeNull();
    expect(nestedGetter).not.toHaveBeenCalled();
  });

  test("projects the full proposal to the exact six-key view contract", () => {
    const internal = proposal();
    const projected = projectWidgetAnnotationLifecycleControlProposal(internal);

    expect(projected).toEqual({
      itemId: internal.itemId,
      operationId: internal.operationId,
      fingerprint: internal.fingerprint,
      expectedState: internal.expectedState,
      nextState: internal.nextState,
      expiresAt: internal.expiresAt,
    });
    expect(Object.keys(projected ?? {})).toEqual([
      "itemId",
      "operationId",
      "fingerprint",
      "expectedState",
      "nextState",
      "expiresAt",
    ]);
    expect(projected).not.toHaveProperty("label");
    expect(projected).not.toHaveProperty("reference");
  });
});

describe("in-page widget production action consumer", () => {
  test("adds basic diagnostics only to an explicit enabled selection-set command", () => {
    expect(createWidgetSelectionSetCommand(true, "explicit", 7, true)).toEqual({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "explicit",
      expectedGeneration: 7,
      collectBasicDiagnostics: true,
    });
    expect(createWidgetSelectionSetCommand(false, "explicit", 7, true)).toEqual({
      type: "ui-attach:widget-selection-set",
      enabled: false,
      intent: "explicit",
      expectedGeneration: 7,
    });
    expect(createWidgetSelectionSetCommand(true, "resume", 7, true)).toEqual({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "resume",
      expectedGeneration: 7,
    });
    expect(createWidgetSelectionSetCommand(
      true,
      "explicit",
      7,
      "yes" as unknown as boolean,
    )).toEqual({
      type: "ui-attach:widget-selection-set",
      enabled: true,
      intent: "explicit",
      expectedGeneration: 7,
    });
    expect(createWidgetSelectionSetCommand(
      "yes" as unknown as boolean,
      "explicit",
      7,
      true,
    )).toEqual({
      type: "ui-attach:widget-selection-set",
      enabled: "yes",
      intent: "explicit",
      expectedGeneration: 7,
    });
  });

  test("keeps a concurrent diagnostics toggle from consuming the newer one-shot intent", () => {
    const state = createWidgetBasicDiagnosticsState();
    expect(state.snapshot()).toEqual({ enabled: false, generation: 0 });

    state.setEnabled("yes" as unknown as boolean);
    expect(state.snapshot().enabled).toBe(false);

    state.setEnabled(true);
    const oldIntent = state.snapshot();
    state.setEnabled(true);
    expect(state.consume(oldIntent)).toBe(false);
    expect(state.snapshot().enabled).toBe(true);

    const currentIntent = state.snapshot();
    expect(state.consume(currentIntent)).toBe(true);
    expect(state.snapshot().enabled).toBe(false);

    state.setEnabled(true);
    const disabledIntent = state.snapshot();
    state.setEnabled(false);
    expect(state.consume(disabledIntent)).toBe(false);
    expect(state.snapshot().enabled).toBe(false);

    state.setEnabled(true);
    const nextIntent = state.snapshot();
    expect(state.consume(nextIntent)).toBe(true);
    expect(state.snapshot().enabled).toBe(false);

    const beforeFailedEnable = state.snapshot();
    state.setEnabled(true);
    const failedEnable = state.snapshot();
    expect(state.restore(failedEnable, beforeFailedEnable.enabled)).toBe(true);
    expect(state.snapshot().enabled).toBe(false);

    state.setEnabled(true);
    const staleFailure = state.snapshot();
    state.setEnabled(false);
    expect(state.restore(staleFailure, true)).toBe(false);
    expect(state.snapshot().enabled).toBe(false);
  });

  test("creates only a boolean lease-bound diagnostics arm or revoke command", () => {
    expect(createWidgetBasicDiagnosticsSetCommand(true, 7)).toEqual({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: true,
      expectedGeneration: 7,
    });
    expect(createWidgetBasicDiagnosticsSetCommand(false, 8)).toEqual({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: false,
      expectedGeneration: 8,
    });
    expect(createWidgetBasicDiagnosticsSetCommand(
      "true" as unknown as boolean,
      -1,
    )).toEqual({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: false,
      expectedGeneration: 0,
    });
  });

  test("opens the full side panel only from a trusted widget interaction", async () => {
    const send = vi.fn(async () => ({ ok: true, data: null } as const));

    await expect(openFullSidePanelFromWidgetInteraction({ isTrusted: false }, send))
      .resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();

    await expect(openFullSidePanelFromWidgetInteraction({ isTrusted: true }, send))
      .resolves.toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: "ui-attach:widget-side-panel-open" });
  });

  test("opens directly inside the trusted widget gesture without forwarding through background", async () => {
    const send = vi.fn(async () => ({ ok: true, data: null } as const));
    const directOpen = vi.fn(async () => undefined);

    await expect(openFullSidePanelFromWidgetInteraction(
      { isTrusted: false },
      send,
      undefined,
      {},
      directOpen,
    )).resolves.toBe(false);
    expect(directOpen).not.toHaveBeenCalled();

    await expect(openFullSidePanelFromWidgetInteraction(
      { isTrusted: true },
      send,
      undefined,
      {},
      directOpen,
    )).resolves.toBe(true);
    expect(directOpen).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test("does not retry through background after a direct side-panel rejection", async () => {
    const send = vi.fn(async () => ({ ok: true, data: null } as const));
    const rejection = new Error("direct open rejected");
    const directOpen = vi.fn(async () => { throw rejection; });

    await expect(openFullSidePanelFromWidgetInteraction(
      { isTrusted: true },
      send,
      undefined,
      {},
      directOpen,
    )).rejects.toBe(rejection);
    expect(send).not.toHaveBeenCalled();
  });

  test("keeps a failed full-side-panel command out of the success state", async () => {
    const send = vi.fn(async () => ({
      ok: false,
      code: "CAPTURE_FAILED",
      error: "MeanThis could not open the full side panel.",
    } as const));
    const onError = vi.fn();
    const onSuccess = vi.fn();

    await expect(runWidgetIntentAction(
      async () => {
        await openFullSidePanelFromWidgetInteraction({ isTrusted: true }, send);
      },
      null,
      {
        onStart: vi.fn(),
        onRender: vi.fn(),
        onError,
        onFinally: vi.fn(),
        onSuccess,
      },
    )).resolves.toBe(false);

    expect(send).toHaveBeenCalledWith({ type: "ui-attach:widget-side-panel-open" });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      new Error("MeanThis could not open the full side panel."),
    );
  });

  test("returns a precise user-facing timeout when the full-side-panel command never settles", async () => {
    const send = vi.fn(() => new Promise<SessionCommandResponse<null>>(() => undefined));
    const timer = createManualTimer();
    const pending = openFullSidePanelFromWidgetInteraction(
      { isTrusted: true },
      send,
      "fallback failure",
      { timeoutMs: 5_000, timer: timer.api },
    );

    expect(send).toHaveBeenCalledOnce();
    expect(timer.api.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5_000);
    timer.fire();

    await expect(pending).rejects.toEqual(
      new Error("MeanThis could not open the full side panel within 5 seconds. Try again."),
    );
    expect(timer.api.clearTimeout).toHaveBeenCalledWith(timer.handle);
    expect(send).toHaveBeenCalledOnce();
  });

  test.each(["resolve", "reject"] as const)(
    "consumes a late full-side-panel %s after timeout without retrying",
    async (outcome) => {
      let resolveResponse!: (response: SessionCommandResponse<null>) => void;
      let rejectResponse!: (error?: unknown) => void;
      const response = new Promise<SessionCommandResponse<null>>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      const send = vi.fn(() => response);
      const timer = createManualTimer();
      const pending = openFullSidePanelFromWidgetInteraction(
        { isTrusted: true },
        send,
        undefined,
        { timeoutMs: 5_000, timer: timer.api },
      );

      timer.fire();
      await expect(pending).rejects.toEqual(
        new Error("MeanThis could not open the full side panel within 5 seconds. Try again."),
      );

      if (outcome === "resolve") resolveResponse({ ok: true, data: null });
      else rejectResponse(new Error("late side-panel failure"));
      await flushMicrotasks();

      expect(send).toHaveBeenCalledOnce();
      expect(timer.api.clearTimeout).toHaveBeenCalledWith(timer.handle);
    },
  );

  test("collapses immediately while stopping an active selection in the same click", async () => {
    let finishStop: ((enabled: boolean) => void) | null = null;
    const collapse = vi.fn();
    const restore = vi.fn();
    const intent = { isCurrent: () => true };
    const pending = collapseWidgetSurface(intent, {
      collapse,
      synchronizeSelection: vi.fn(async () => true),
      stopSelection: vi.fn(() => new Promise<boolean>((resolve) => {
        finishStop = resolve;
      })),
      restore,
    });

    expect(collapse).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    await Promise.resolve();
    finishStop?.(false);
    await expect(pending).resolves.toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });

  test("serializes a pending selection start before collapse stops terminal authority", async () => {
    const queue = createWidgetSelectionActionQueue();
    const barrier = createSelectionIntentBarrier();
    let releaseEnable!: () => void;
    let remoteEnabled = false;
    let localEnabled = false;
    let mode: "ready" | "collapsed" | "selecting" = "ready";
    const startIntent = barrier.beginIntent();
    const starting = queue.enqueue(async () => {
      await new Promise<void>((resolve) => { releaseEnable = resolve; });
      remoteEnabled = true;
      if (startIntent.isCurrent()) localEnabled = true;
    });
    await Promise.resolve();

    const collapseIntent = barrier.beginIntent();
    mode = "collapsed";
    const synchronizeSelection = vi.fn(async () => {
      localEnabled = remoteEnabled;
      return localEnabled;
    });
    const stopSelection = vi.fn(async () => {
      remoteEnabled = false;
      localEnabled = false;
      return false;
    });
    const collapsing = queue.enqueue(async () => {
      localEnabled = await collapseWidgetSurface(collapseIntent, {
        collapse: () => { mode = "collapsed"; },
        synchronizeSelection,
        stopSelection,
        restore: () => { mode = localEnabled ? "selecting" : "ready"; },
      });
    });

    expect(mode).toBe("collapsed");
    expect(synchronizeSelection).not.toHaveBeenCalled();
    expect(stopSelection).not.toHaveBeenCalled();

    releaseEnable();
    await Promise.all([starting, collapsing]);

    expect(synchronizeSelection).toHaveBeenCalledOnce();
    expect(stopSelection).toHaveBeenCalledOnce();
    expect(remoteEnabled).toBe(false);
    expect(localEnabled).toBe(false);
    expect(mode).toBe("collapsed");
  });

  test("keeps the collapse stop intent current for its matching disabled update", () => {
    expect(shouldRotateSelectionIntentForRuntimeUpdate(false, "collapsed")).toBe(false);
    expect(shouldRotateSelectionIntentForRuntimeUpdate(false, "selecting")).toBe(true);
    expect(shouldRotateSelectionIntentForRuntimeUpdate(true, "collapsed")).toBe(false);
  });

  test("projects a bounded invitation countdown and detects only a real expiry transition", () => {
    const expiresAt = "2026-08-23T01:34:00.000Z";
    expect(pendingBridgeRemainingSeconds(expiresAt, Date.parse("2026-08-23T01:32:54.100Z")))
      .toBe(66);
    expect(pendingBridgeRemainingSeconds(expiresAt, Date.parse(expiresAt))).toBe(0);
    expect(pendingBridgeRemainingSeconds("not-a-time", Date.parse(expiresAt))).toBeNull();
    expect(isExpiredBridgeTransition(
      "pending",
      expiresAt,
      { connected: false, pending: false },
      Date.parse(expiresAt),
    )).toBe(true);
    expect(isExpiredBridgeTransition(
      "pending",
      expiresAt,
      { connected: false, pending: false },
      Date.parse("2026-08-23T01:33:59.000Z"),
    )).toBe(false);
    expect(isExpiredBridgeTransition(
      "pending",
      expiresAt,
      { connected: true, pending: false },
      Date.parse(expiresAt),
    )).toBe(false);
  });

  test("treats pagehide as a document disconnect instead of a terminal surface release", () => {
    const disconnectLifecycle = vi.fn();
    const releaseSurface = vi.fn();

    dispatchInPageWidgetLifecycleExit("document-pagehide", {
      disconnectLifecycle,
      releaseSurface,
    });

    expect(disconnectLifecycle).toHaveBeenCalledOnce();
    expect(releaseSurface).not.toHaveBeenCalled();
  });

  test("distinguishes a missing lease from transient top-frame inventory failure", () => {
    expect(registrationFailurePhase({
      ok: false,
      issues: [{ path: "widget", message: "WIDGET_REGISTER_LEASE" }],
    })).toBe("runtime-register-lease");
    expect(registrationFailurePhase({
      ok: false,
      issues: [{ path: "widget", message: "WIDGET_REGISTER_TOP_INVENTORY" }],
    })).toBe("runtime-register-top-inventory");
  });

  test("keeps resolved registration protocol failures diagnostically distinct", () => {
    expect(registrationFailurePhase(undefined)).toBe("runtime-register-invalid-response");
    expect(registrationFailurePhase({
      ok: false,
      code: "CAPTURE_FAILED",
      error: "MeanThis could not complete the request.",
    })).toBe("runtime-register-handler-exception");
    expect(registrationFailurePhase({
      ok: false,
      code: "UNTRUSTED_SENDER",
      error: "The request sender is not trusted.",
    })).toBe("runtime-register-untrusted-response");
    expect(registrationFailurePhase({
      ok: false,
      issues: [{ path: "widget", message: "WIDGET_REGISTER_FUTURE_FAILURE" }],
    })).toBe("runtime-register-unknown-issue");
  });

  test("projects the shared annotation clear status into the view model", () => {
    expect(projectInPageWidgetClearStatus).toBeTypeOf("function");
    expect(projectInPageWidgetClearStatus({
      clearStatus: { clearState: "pending", operationId: "clear-entry-1" },
    })).toEqual({
      clearState: "pending",
      operationId: "clear-entry-1",
    });
  });

  test("EA-01B-CLEAR-C2 invalidates a reconnect resume token when clear starts", async () => {
    expect(createSelectionIntentBarrier).toBeTypeOf("function");
    const barrier = createSelectionIntentBarrier();
    const reconnect = barrier.snapshot();
    let releaseReconnect!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseReconnect = resolve; });
    const resume = waiting.then(() => reconnect.isCurrent());

    const clearIntent = barrier.beginIntent();
    releaseReconnect();

    await expect(resume).resolves.toBe(false);
    expect(clearIntent.isCurrent()).toBe(true);
  });

  test("EA-01B-CLEAR-C2 accepts restart resume state and rejects unsafe generations", () => {
    expect(isWidgetSelectionState({
      enabled: false,
      generation: 4,
      resumeAllowed: true,
    })).toBe(true);
    expect(isWidgetSelectionState({
      enabled: false,
      generation: Number.MAX_SAFE_INTEGER + 1,
      resumeAllowed: true,
    })).toBe(false);
  });

  test("refreshes the terminal clear generation before the next explicit selection intent", async () => {
    expect(synchronizeWidgetSelectionAuthority).toBeTypeOf("function");
    let cached = { enabled: false, generation: 2, resumeAllowed: false };
    const intent = { isCurrent: () => true };

    await expect(synchronizeWidgetSelectionAuthority(
      async () => ({
        ok: true,
        data: { enabled: false, generation: 3, resumeAllowed: false },
      }),
      (state) => { cached = state; },
      intent,
    )).resolves.toBe(true);

    expect(cached.generation).toBe(3);
  });

  test("uses the refreshed cross-surface generation for the next diagnostics arm", async () => {
    let cached = { enabled: true, generation: 7, resumeAllowed: true };
    const intent = { isCurrent: () => true };

    await expect(synchronizeWidgetSelectionAuthority(
      async () => ({
        ok: true,
        data: { enabled: false, generation: 8, resumeAllowed: true },
      }),
      (state) => { cached = state; },
      intent,
    )).resolves.toBe(true);

    expect(createWidgetBasicDiagnosticsSetCommand(true, cached.generation)).toEqual({
      type: "ui-attach:widget-basic-diagnostics-set",
      enabled: true,
      expectedGeneration: 8,
    });
  });

  test("drops an old frame-scope response before it can overwrite a newer selection intent", async () => {
    expect(synchronizeWidgetFrameScopes).toBeTypeOf("function");
    const barrier = createSelectionIntentBarrier();
    const oldIntent = barrier.snapshot();
    let release!: (response: {
      ok: true;
      data: {
        currentFrameId: number;
        scopes: Array<{
          frameId: number;
          parentFrameId: null;
          documentId: string;
          origin: string;
          pathname: string;
          depth: number;
          requiresHostPermission: boolean;
          selectable: boolean;
        }>;
      };
    }) => void;
    const pending = new Promise<Parameters<typeof release>[0]>((resolve) => { release = resolve; });
    const apply = vi.fn();
    const refreshing = synchronizeWidgetFrameScopes(() => pending, apply, oldIntent);

    barrier.beginIntent();
    release({
      ok: true,
      data: {
        currentFrameId: 0,
        scopes: [{
          frameId: 0,
          parentFrameId: null,
          documentId: "top-document",
          origin: "https://example.test",
          pathname: "/settings",
          depth: 0,
          requiresHostPermission: false,
          selectable: true,
        }],
      },
    });

    await expect(refreshing).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  test("does not keep authenticated UI waiting for initial frame-scope inventory", async () => {
    const order: string[] = [];
    let releaseScopes!: () => void;
    const scopes = new Promise<boolean>((resolve) => {
      releaseScopes = () => {
        order.push("scopes-ready");
        resolve(true);
      };
    });

    await initializeWidgetCoreWithDeferredFrameScopes(
      async () => { order.push("core-ready"); },
      () => { order.push("authenticated-ui-ready"); },
      async () => scopes,
    );

    expect(order).toEqual(["core-ready", "authenticated-ui-ready"]);
    releaseScopes();
    await scopes;
    expect(order).toEqual(["core-ready", "authenticated-ui-ready", "scopes-ready"]);
  });

  test("starts runtime observation before pending core hydration can miss an update", async () => {
    const order: string[] = [];
    let releaseCore!: () => void;
    const core = new Promise<void>((resolve) => {
      releaseCore = resolve;
    });

    const initializing = initializeWidgetCoreWithDeferredFrameScopes(
      async () => {
        order.push("core-started");
        await core;
        order.push("core-ready");
      },
      () => { order.push("authenticated-ui-ready"); },
      async () => true,
      () => { order.push("runtime-observing"); },
    );
    await Promise.resolve();

    expect(order).toEqual(["runtime-observing", "core-started"]);
    releaseCore();
    await initializing;
    expect(order).toEqual([
      "runtime-observing",
      "core-started",
      "core-ready",
      "authenticated-ui-ready",
    ]);
  });

  test("drops a late frame-scope count response when a newer refresh shares the same selection intent", async () => {
    expect(synchronizeWidgetFrameScopes).toBeTypeOf("function");
    const selectionBarrier = createSelectionIntentBarrier();
    const requestBarrier = createSelectionIntentBarrier();
    const selectionIntent = selectionBarrier.snapshot();
    const oldRequest = requestBarrier.snapshot();
    let releaseOld!: (state: {
      currentFrameId: number;
      scopes: Array<{
        frameId: number;
        parentFrameId: null;
        documentId: string;
        origin: string;
        pathname: string;
        depth: number;
        requiresHostPermission: boolean;
        selectable: boolean;
        itemCount: number;
      }>;
    }) => void;
    const oldResponse = new Promise<Parameters<typeof releaseOld>[0]>((resolve) => {
      releaseOld = resolve;
    });
    const apply = vi.fn();
    const oldRefresh = synchronizeWidgetFrameScopes(
      () => oldResponse,
      apply,
      selectionIntent,
      oldRequest,
    );

    const newRequest = requestBarrier.beginIntent();
    await expect(synchronizeWidgetFrameScopes(async () => ({
      currentFrameId: 5,
      scopes: [{
        frameId: 5,
        parentFrameId: null,
        documentId: "child-document",
        origin: "https://frame.test",
        pathname: "/editor",
        depth: 1,
        requiresHostPermission: false,
        selectable: true,
        itemCount: 4,
      }],
    }), apply, selectionIntent, newRequest)).resolves.toBe(true);

    releaseOld({
      currentFrameId: 0,
      scopes: [{
        frameId: 0,
        parentFrameId: null,
        documentId: "top-document",
        origin: "https://example.test",
        pathname: "/settings",
        depth: 0,
        requiresHostPermission: false,
        selectable: true,
        itemCount: 3,
      }],
    });
    await expect(oldRefresh).resolves.toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ currentFrameId: 5 }));
  });

  test.each(["old-first", "new-first", "old-rejects"] as const)(
    "waits for the latest successful scope read when overlapping refreshes settle %s",
    async (order) => {
      const selectionBarrier = createSelectionIntentBarrier();
      const requestBarrier = createSelectionIntentBarrier();
      const intent = selectionBarrier.snapshot();
      const drain = createWidgetFrameScopeRefreshDrain();
      const apply = vi.fn();
      let finishOld!: () => void;
      let failOld!: (error: Error) => void;
      let finishNew!: () => void;
      const oldRead = new Promise<void>((resolve, reject) => {
        finishOld = resolve;
        failOld = reject;
      });
      const newRead = new Promise<void>((resolve) => { finishNew = resolve; });
      const start = (read: Promise<void>, frameId: number) => drain(
        synchronizeWidgetFrameScopes(async () => {
          await read;
          return { currentFrameId: frameId, scopes: [] };
        }, apply, intent, requestBarrier.beginIntent()),
        intent,
      );
      const oldSettled = vi.fn();
      const oldRefresh = start(oldRead, 0).then((result) => {
        oldSettled();
        return result;
      });
      const newRefresh = start(newRead, 5);
      if (order === "new-first") {
        finishNew();
        await expect(newRefresh).resolves.toBe(true);
        finishOld();
      } else {
        if (order === "old-rejects") failOld(new Error("obsolete scope failure"));
        else finishOld();
        await oldRead.catch(() => undefined);
        await Promise.resolve();
        expect(oldSettled).not.toHaveBeenCalled();
        finishNew();
      }
      await expect(oldRefresh).resolves.toBe(true);
      await expect(newRefresh).resolves.toBe(true);
      expect(apply).toHaveBeenCalledOnce();
      expect(apply).toHaveBeenCalledWith({ currentFrameId: 5, scopes: [] });
    },
  );

  test("propagates the latest scope failure to the superseded caller", async () => {
    const intent = createSelectionIntentBarrier().snapshot();
    const drain = createWidgetFrameScopeRefreshDrain();
    let finishOld!: (result: boolean) => void;
    const oldRead = new Promise<boolean>((resolve) => { finishOld = resolve; });
    const oldRefresh = drain(oldRead, intent);
    const oldCheck = expect(oldRefresh).rejects.toThrow("current scope failure");
    const newRefresh = drain(Promise.reject(new Error("current scope failure")), intent);
    await expect(newRefresh).rejects.toThrow("current scope failure");
    finishOld(false);
    await oldCheck;
  });

  test("does not resume a cancelled selection after waiting for newer scopes", async () => {
    const selectionBarrier = createSelectionIntentBarrier();
    const oldIntent = selectionBarrier.snapshot();
    const drain = createWidgetFrameScopeRefreshDrain();
    let finishOld!: (result: boolean) => void;
    const oldRead = new Promise<boolean>((resolve) => { finishOld = resolve; });
    const select = vi.fn();
    const oldRefresh = drain(oldRead, oldIntent).then((synchronized) => {
      if (synchronized) select();
      return synchronized;
    });
    const currentIntent = selectionBarrier.beginIntent();
    await expect(drain(Promise.resolve(true), currentIntent)).resolves.toBe(true);
    finishOld(false);
    await expect(oldRefresh).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  test.each([
    [128, true],
    [129, true],
    [256, true],
    [257, false],
  ] as const)("enforces the %i-character frame-scope item id boundary", (length, accepted) => {
    const parsed = parseWidgetFrameScopeListData({
      currentFrameId: 0,
      scopes: [{
        frameId: 0,
        parentFrameId: null,
        documentId: "top-document",
        origin: "https://example.test",
        pathname: "/settings",
        depth: 0,
        requiresHostPermission: false,
        selectable: true,
        itemCount: 1,
        itemIds: ["a".repeat(length)],
      }],
    });

    expect(parsed !== null).toBe(accepted);
  });

  test("keeps the widget on the session-authoritative SPA route after selection stops", () => {
    expect(resolveWidgetPageItemIds(
      ["route-b"],
      ["route-a", "route-b"],
      ["route-a", "route-b"],
    )).toEqual(["route-b"]);
    expect(resolveWidgetPageItemIds(
      null,
      ["route-b"],
      ["route-a", "route-b"],
    )).toEqual(["route-b"]);
  });

  test("refreshes the authoritative session and scope counts before committing a scope switch", async () => {
    expect(synchronizeWidgetFrameScopeContext).toBeTypeOf("function");
    const barrier = createSelectionIntentBarrier();
    const intent = barrier.snapshot();
    const order: string[] = [];
    const commit = vi.fn((enabled: boolean) => { order.push(`commit:${enabled}`); });

    await expect(synchronizeWidgetFrameScopeContext(
      async () => { order.push("select"); return true; },
      async () => { order.push("session"); return true; },
      async () => { order.push("scopes"); return true; },
      commit,
      intent,
    )).resolves.toBe(true);

    expect(order).toEqual(["select", "session", "scopes", "commit:true"]);
    expect(commit).toHaveBeenCalledOnce();
  });

  test("does not commit a scope switch when the authoritative session refresh fails", async () => {
    const barrier = createSelectionIntentBarrier();
    const refreshScopes = vi.fn(async () => true);
    const commit = vi.fn();

    await expect(synchronizeWidgetFrameScopeContext(
      async () => true,
      async () => false,
      refreshScopes,
      commit,
      barrier.snapshot(),
    )).resolves.toBe(false);

    expect(refreshScopes).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test("does not treat a superseded scope refresh as success when its successor fails", async () => {
    const selectionBarrier = createSelectionIntentBarrier();
    const requestBarrier = createSelectionIntentBarrier();
    const selectionIntent = selectionBarrier.snapshot();
    const oldRequest = requestBarrier.snapshot();
    let releaseOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
    const apply = vi.fn();
    const oldRefresh = synchronizeWidgetFrameScopes(async () => {
      await oldResponse;
      return { currentFrameId: 0, scopes: [] };
    }, apply, selectionIntent, oldRequest);

    const newRequest = requestBarrier.beginIntent();
    await expect(synchronizeWidgetFrameScopes(
      async () => { throw new Error("scope read failed"); },
      apply,
      selectionIntent,
      newRequest,
    )).rejects.toThrow("scope read failed");
    releaseOld();

    await expect(oldRefresh).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  test("does not let an old failure fallback overwrite a newer intent after permission cleanup", async () => {
    expect(settleWidgetIntentFailure).toBeTypeOf("function");
    const barrier = createSelectionIntentBarrier();
    const oldIntent = barrier.snapshot();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const applyFailure = vi.fn();
    const settling = settleWidgetIntentFailure(oldIntent, async () => cleanup, applyFailure);

    barrier.beginIntent();
    releaseCleanup();

    await expect(settling).resolves.toBe(false);
    expect(applyFailure).not.toHaveBeenCalled();
  });

  test("does not let an old action failure overwrite a newer intent status or busy state", async () => {
    expect(runWidgetIntentAction).toBeTypeOf("function");
    const barrier = createSelectionIntentBarrier();
    const oldIntent = barrier.snapshot();
    let rejectOldAction!: (error: Error) => void;
    const oldAction = new Promise<void>((_resolve, reject) => { rejectOldAction = reject; });
    let busyOwner = "old";
    const effects = {
      onStart: vi.fn(),
      onRender: vi.fn(),
      onError: vi.fn(),
      onFinally: vi.fn((_current: boolean) => {
        if (busyOwner === "old") busyOwner = "";
      }),
    };
    const running = runWidgetIntentAction(() => oldAction, oldIntent, effects);

    barrier.beginIntent();
    rejectOldAction(new Error("old action failed"));
    await running;

    expect(effects.onStart).toHaveBeenCalledOnce();
    expect(effects.onRender).toHaveBeenCalledOnce();
    expect(effects.onError).not.toHaveBeenCalled();
    expect(effects.onFinally).toHaveBeenCalledWith(false);
    expect(busyOwner).toBe("");
  });

  test("keeps a newer annotation busy state when an old local action clears the same value", () => {
    expect(projectInPageWidgetBusyAction).toBeTypeOf("function");
    const oldLocalBusy: "copy" | null = "copy";
    const newerAnnotationBusy: "copy" | null = "copy";

    expect(projectInPageWidgetBusyAction(newerAnnotationBusy, oldLocalBusy)).toBe("copy");
    expect(projectInPageWidgetBusyAction(newerAnnotationBusy, null)).toBe("copy");
  });

  test("does not publish a late local status after a newer annotation action begins", async () => {
    expect(projectInPageWidgetStatus).toBeTypeOf("function");
    const actionBarrier = createSelectionIntentBarrier();
    const oldActionIntent = actionBarrier.snapshot();
    let finishOldCopy!: () => void;
    const oldCopy = new Promise<void>((resolve) => { finishOldCopy = resolve; });
    let localStatus: { kind: "success"; message: string } | null = null;
    const running = runWidgetIntentAction(() => oldCopy, oldActionIntent, {
      onStart: vi.fn(),
      onRender: vi.fn(),
      onError: vi.fn(),
      onFinally: vi.fn(),
    }).then((completed) => {
      if (completed) localStatus = { kind: "success", message: "old copy" };
      return completed;
    });

    actionBarrier.beginIntent();
    finishOldCopy();

    await expect(running).resolves.toBe(false);
    expect(localStatus).toBeNull();
    expect(projectInPageWidgetStatus(
      { value: { kind: "success", message: "new annotation" }, revision: 2 },
      { value: localStatus, revision: 1 },
    )).toEqual({ kind: "success", message: "new annotation" });
  });

  test("projects the newest status writer and lets a newer clear retire an old error", () => {
    const annotationError = { kind: "error" as const, message: "old annotation" };
    const localSuccess = { kind: "success" as const, message: "new local" };

    expect(projectInPageWidgetStatus(
      { value: annotationError, revision: 3 },
      { value: localSuccess, revision: 4 },
    )).toEqual(localSuccess);
    expect(projectInPageWidgetStatus(
      { value: annotationError, revision: 3 },
      { value: null, revision: 4 },
    )).toBeNull();
  });

  test("shows a current draft's autosave failure even after an unrelated success, then retires it after retry", () => {
    const copyStatus = { value: { kind: "success" as const, message: "Copied." }, revision: 4 };
    const localStatus = { value: null, revision: 3 };
    const taskNote = {
      snapshot: {
        selectedItemId: "att_save",
        intentDirty: true,
        clearPending: false,
        sessionMutationPending: false,
        status: { kind: "error" as const, message: "Internal storage error." },
      },
      activeItemId: "att_save",
      strings: { saving: "Saving…", taskNoteSaveFailed: "Task note was not saved." },
    };
    expect(projectInPageWidgetStatus(copyStatus, localStatus, taskNote))
      .toEqual({ kind: "error", message: "Task note was not saved." });
    expect(projectInPageWidgetStatus(copyStatus, localStatus, {
      ...taskNote, snapshot: { ...taskNote.snapshot, status: { kind: "saving", message: "Saving intent." } },
    })).toEqual({ kind: "info", message: "Saving…" });
    expect(projectInPageWidgetStatus(copyStatus, localStatus, {
      ...taskNote, snapshot: { ...taskNote.snapshot, intentDirty: false },
    })).toEqual(copyStatus.value);
    expect(projectInPageWidgetStatus(copyStatus, localStatus, {
      ...taskNote, activeItemId: "att_cancel",
    })).toEqual(copyStatus.value);
    expect(projectInPageWidgetStatus(copyStatus, localStatus, {
      ...taskNote, snapshot: { ...taskNote.snapshot, clearPending: true },
    })).toEqual(copyStatus.value);
    expect(projectInPageWidgetStatus(copyStatus, localStatus, {
      ...taskNote, snapshot: { ...taskNote.snapshot, sessionMutationPending: true },
    })).toEqual(copyStatus.value);
  });

  test("an autosave progress message does not hide another action's error", () => {
    const actionError = { kind: "error" as const, message: "Page access denied." };
    expect(projectInPageWidgetStatus(
      { value: actionError, revision: 4 },
      { value: null, revision: 3 },
      {
        snapshot: {
          selectedItemId: "att_save", intentDirty: true, clearPending: false,
          sessionMutationPending: false, status: { kind: "saving", message: "Saving intent." },
        },
        activeItemId: "att_save",
        strings: { saving: "Saving…", taskNoteSaveFailed: "Task note was not saved." },
      },
    )).toEqual(actionError);
  });

  test("ACKs a completed action only after that action is replayed on the replacement port", async () => {
    const firstPort = { postMessage: vi.fn() };
    const secondPort = { postMessage: vi.fn() };
    let currentPort: typeof firstPort | typeof secondPort | null = firstPort;
    let finishEdit!: (value: boolean) => void;
    const editResult = new Promise<boolean>((resolve) => { finishEdit = resolve; });
    const edit = vi.fn(async () => editResult);
    const consumer = createInPageWidgetActionConsumer({
      getCurrentPort: () => currentPort,
      getSurfaceId: () => SURFACE_ID,
      refreshActiveOrigin: vi.fn(async () => undefined),
      hasAuthoritativeItem: vi.fn(() => true),
      edit,
      more: vi.fn(async () => true),
    });
    const action: InPageWidgetActionMessage = {
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      action: "edit",
      itemId: "att_save",
    };

    consumer.receive(action);
    await Promise.resolve();
    currentPort = secondPort;
    finishEdit(true);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(firstPort.postMessage).not.toHaveBeenCalled();
    expect(secondPort.postMessage).not.toHaveBeenCalled();

    consumer.receive({ ...action });
    await vi.waitFor(() => expect(secondPort.postMessage).toHaveBeenCalledOnce());
    expect(secondPort.postMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      outcome: "consumed",
    });
    expect(edit).toHaveBeenCalledOnce();
  });

  test("maps the production More boolean to rejected versus consumed ACKs", async () => {
    const port = { postMessage: vi.fn() };
    const more = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const surface = { more };
    const consumer = createInPageWidgetActionConsumer({
      getCurrentPort: () => port,
      getSurfaceId: () => SURFACE_ID,
      refreshActiveOrigin: vi.fn(async () => undefined),
      hasAuthoritativeItem: vi.fn(() => true),
      edit: vi.fn(async () => true),
      more: (itemId) => consumeInPageWidgetMore(surface, itemId),
    });

    consumer.receive({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      action: "more",
      itemId: "att_false",
    });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      outcome: "rejected",
    });

    consumer.receive({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: "d2a55a79-8343-455c-8f6e-98944aa9a15f",
      action: "more",
      itemId: "att_true",
    });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(2));
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      actionId: "d2a55a79-8343-455c-8f6e-98944aa9a15f",
      outcome: "consumed",
    }));
  });

  test("deduplicates one full fingerprint and replays its ACK only to the current port", async () => {
    const firstPort = { postMessage: vi.fn() };
    const secondPort = { postMessage: vi.fn() };
    const thirdPort = { postMessage: vi.fn() };
    let currentPort: typeof firstPort | null = firstPort;
    let finishEdit!: (value: boolean) => void;
    const editResult = new Promise<boolean>((resolve) => { finishEdit = resolve; });
    const edit = vi.fn(async () => editResult);
    const consumer = createInPageWidgetActionConsumer({
      getCurrentPort: () => currentPort,
      getSurfaceId: () => SURFACE_ID,
      refreshActiveOrigin: vi.fn(async () => undefined),
      hasAuthoritativeItem: vi.fn(() => true),
      edit,
      more: vi.fn(async () => true),
    });
    const action: InPageWidgetActionMessage = {
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      action: "edit",
      itemId: "att_save",
    };

    consumer.receive(action);
    consumer.receive({ ...action });
    await Promise.resolve();
    expect(edit).toHaveBeenCalledOnce();

    currentPort = secondPort;
    finishEdit(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(firstPort.postMessage).not.toHaveBeenCalled();
    expect(secondPort.postMessage).not.toHaveBeenCalled();
    consumer.receive({ ...action });
    await vi.waitFor(() => expect(secondPort.postMessage).toHaveBeenCalledOnce());
    expect(secondPort.postMessage).toHaveBeenCalledWith({
      type: UI_ATTACH_IN_PAGE_WIDGET_ACTION_ACK,
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      outcome: "consumed",
    });

    currentPort = thirdPort;
    consumer.receive({ ...action });
    await Promise.resolve();
    await Promise.resolve();
    expect(edit).toHaveBeenCalledOnce();
    expect(thirdPort.postMessage).toHaveBeenCalledOnce();
  });

  test("fails closed when one action id is replayed with a different fingerprint", async () => {
    const port = { postMessage: vi.fn() };
    const edit = vi.fn(async () => true);
    const more = vi.fn(async () => true);
    const consumer = createInPageWidgetActionConsumer({
      getCurrentPort: () => port,
      getSurfaceId: () => SURFACE_ID,
      refreshActiveOrigin: vi.fn(async () => undefined),
      hasAuthoritativeItem: vi.fn(() => true),
      edit,
      more,
    });
    const action: InPageWidgetActionMessage = {
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      action: "edit",
      itemId: "att_save",
    };

    consumer.receive(action);
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    port.postMessage.mockClear();
    consumer.receive({ ...action, action: "more", itemId: "att_other" });
    await Promise.resolve();
    await Promise.resolve();

    expect(edit).toHaveBeenCalledOnce();
    expect(more).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  test("refreshes and verifies authoritative readback before edit or More", async () => {
    const order: string[] = [];
    const port = { postMessage: vi.fn() };
    let ownsItem = false;
    const edit = vi.fn(async () => {
      order.push("edit");
      return true;
    });
    const more = vi.fn(async () => {
      order.push("more");
      return true;
    });
    const consumer = createInPageWidgetActionConsumer({
      getCurrentPort: () => port,
      getSurfaceId: () => SURFACE_ID,
      refreshActiveOrigin: vi.fn(async () => { order.push("refresh"); }),
      hasAuthoritativeItem: vi.fn(() => {
        order.push("readback");
        return ownsItem;
      }),
      edit,
      more,
    });

    consumer.receive({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: ACTION_ID,
      action: "edit",
      itemId: "att_save",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["refresh", "readback"]);
    expect(edit).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      outcome: "rejected",
    }));

    ownsItem = true;
    order.length = 0;
    consumer.receive({
      type: "ui-attach:in-page-widget-action",
      surfaceId: SURFACE_ID,
      actionId: "6b2bb8d7-7e29-4794-a1bc-8ea1dfc54386",
      action: "more",
      itemId: "att_more",
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["refresh", "readback", "more"]);
  });
});

function createManualTimer() {
  let callback: (() => void) | null = null;
  const handle = {} as ReturnType<typeof setTimeout>;
  const api = {
    setTimeout: vi.fn((next: () => void, _delayMs: number) => {
      callback = next;
      return handle;
    }),
    clearTimeout: vi.fn((_handle: ReturnType<typeof setTimeout>) => undefined),
  };
  return {
    api,
    handle,
    fire(): void {
      callback?.();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
