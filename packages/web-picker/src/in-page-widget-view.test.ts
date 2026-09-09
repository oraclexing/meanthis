// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { PrivateDebugSummaryV1 } from "@meanthis/schema";
import {
  DEFAULT_IN_PAGE_WIDGET_STRINGS,
  IN_PAGE_WIDGET_CSS,
  createInPageWidgetStrings,
  createInPageWidgetView,
  sanitizeClearStatus,
  sanitizeInPageWidgetViewModel,
  type InPageWidgetInteraction,
  type InPageWidgetLifecycleControlProposal,
  type InPageWidgetViewModel,
} from "./in-page-widget-view";

describe("sanitizeInPageWidgetViewModel", () => {
  test("bounds and copies untrusted display data without retaining duplicate opaque ids", () => {
    const input = {
      mode: "editing",
      bridgeState: "connected",
      bridgeInvitationRemainingSeconds: 65,
      collectBasicDiagnosticsForNextCapture: true,
      disclosureRequired: true,
      clearConfirmationRequired: true,
      connectionRequestText: ` invitation\u0000${"x".repeat(20_000)} `,
      frameScopeOpen: true,
      frameScopes: [
        {
          id: "scope-top",
          kind: "top",
          detail: " https://example.test/\n ",
          depth: 0,
          current: false,
          selectable: true,
        },
        {
          id: "scope-child",
          kind: "embedded",
          detail: `https://frame.test/${"x".repeat(300)}`,
          depth: 1,
          current: true,
          selectable: true,
        },
        {
          id: "scope-child",
          kind: "embedded",
          detail: "duplicate",
          depth: 2,
          current: true,
          selectable: true,
        },
      ],
      targets: [
        {
          itemId: "item-a",
          label: " A\n ",
          name: `<img src=x onerror="secret()">\u202e${"x".repeat(120)}`,
        },
        { itemId: "item-a", label: "duplicate", name: "Duplicate" },
        { itemId: "invalid\u0000id", label: "invalid", name: "Unsafe id" },
        { itemId: "", label: "invalid", name: "Missing id" },
      ],
      activeItemId: "item-a",
      taskNote: `First\r\nsecond\u0000${"n".repeat(20_000)}`,
      shortcuts: [
        { id: "space", label: " Same\nspacing ", note: "Keep A aligned.\u0000" },
        { id: "space", label: "Duplicate", note: "Ignored" },
      ],
      busyAction: "save",
      status: { kind: "success", message: " Saved\u0000 " },
    } satisfies InPageWidgetViewModel;

    const sanitized = sanitizeInPageWidgetViewModel(input);

    expect(sanitized.mode).toBe("editing");
    expect(sanitized.bridgeState).toBe("connected");
    expect(sanitized.bridgeInvitationRemainingSeconds).toBe(65);
    expect(sanitized.collectBasicDiagnosticsForNextCapture).toBe(true);
    expect(sanitized.privateDebugSummary).toBeNull();
    expect(sanitized.privateDebugSummaryCopied).toBe(false);
    expect(sanitized.disclosureRequired).toBe(true);
    expect(sanitized.clearConfirmationRequired).toBe(true);
    expect(sanitized.clearStatus).toEqual({ clearState: "idle", operationId: null });
    expect(sanitized.connectionRequestText).not.toContain("\u0000");
    expect(sanitized.connectionRequestText?.length).toBeLessThanOrEqual(16_384);
    expect(sanitized.frameScopeOpen).toBe(true);
    expect(sanitized.frameScopes).toEqual([
      {
        id: "scope-top",
        kind: "top",
        detail: "https://example.test/",
        depth: 0,
        current: false,
        selectable: true,
      },
      {
        id: "scope-child",
        kind: "embedded",
        detail: expect.stringMatching(/^https:\/\/frame\.test\//u),
        depth: 1,
        current: true,
        selectable: true,
      },
    ]);
    expect(sanitized.frameScopes[1]?.detail.length).toBeLessThanOrEqual(240);
    expect(sanitized.targets).toHaveLength(1);
    expect(sanitized.targets[0]).toMatchObject({
      itemId: "item-a",
      label: "A",
    });
    expect(sanitized.targets[0]?.name).not.toContain("\u202e");
    expect(sanitized.targets[0]?.name.length).toBeLessThanOrEqual(80);
    expect(sanitized.activeItemId).toBe("item-a");
    expect(sanitized.taskNote).toContain("First\nsecond");
    expect(sanitized.taskNote).not.toContain("\u0000");
    expect(sanitized.taskNote.length).toBeLessThanOrEqual(16_384);
    expect(sanitized.shortcuts).toEqual([
      { id: "space", label: "Same spacing", note: "Keep A aligned." },
    ]);
    expect(sanitized.status).toEqual({ kind: "success", message: "Saved" });

    input.targets[0]!.name = "Changed after sanitizing";
    input.shortcuts[0]!.note = "Changed after sanitizing";
    expect(sanitized.targets[0]?.name).not.toBe("Changed after sanitizing");
    expect(sanitized.shortcuts[0]?.note).toBe("Keep A aligned.");
  });

  test("falls back to safe closed states for malformed runtime values", () => {
    const sanitized = sanitizeInPageWidgetViewModel({
      mode: "open",
      bridgeState: "ready",
      bridgeInvitationRemainingSeconds: -1,
      collectBasicDiagnosticsForNextCapture: "yes",
      disclosureRequired: "yes",
      connectionRequestText: 42,
      targets: "not-an-array",
      activeItemId: 42,
      taskNote: null,
      shortcuts: null,
      busyAction: "upload",
      status: { kind: "debug", message: "not public" },
    } as unknown as InPageWidgetViewModel);

    expect(sanitized).toEqual({
      mode: "collapsed",
      selectionEnabled: false,
      readiness: "ready",
      bridgeState: "unavailable",
      bridgeInvitationRemainingSeconds: null,
      bridgeSharedTargetCount: null,
      bridgeSharedSequence: null,
      bridgeReadAcknowledgementState: "unavailable",
      disclosureRequired: false,
      clearConfirmationRequired: false,
      clearStatus: { clearState: "idle", operationId: null },
      connectionRequestText: null,
      manualCopyText: null,
      outputDetail: "compact",
      displayMode: "hover",
      collectBasicDiagnosticsForNextCapture: false,
      basicDiagnosticsCommandRevision: 0,
      privateDebugSummary: null,
      privateDebugSummaryCopied: false,
      referenceScope: "page",
      pageTargetCount: 0,
      siteTargetCount: 0,
      siteLabel: "site",
      frameScopeOpen: false,
      frameScopes: [],
      targets: [],
      lifecycleControlProposal: null,
      activeItemId: null,
      taskNote: "",
      recoveryDraft: null,
      shortcuts: [],
      busyAction: null,
      status: null,
    });
  });

  test("sanitizes bounded page and site reference scope metadata", () => {
    expect(sanitizeInPageWidgetViewModel(model({
      referenceScope: "site",
      pageTargetCount: 2,
      siteTargetCount: 4,
      siteLabel: "x.com",
    }))).toMatchObject({
      referenceScope: "site",
      pageTargetCount: 2,
      siteTargetCount: 4,
      siteLabel: "x.com",
    });

    expect(sanitizeInPageWidgetViewModel({
      ...model(),
      referenceScope: "origin",
      pageTargetCount: -1,
      siteTargetCount: Number.MAX_SAFE_INTEGER,
      siteLabel: "\u0000host",
    } as unknown as InPageWidgetViewModel)).toMatchObject({
      referenceScope: "page",
      pageTargetCount: 2,
      siteTargetCount: 2,
      siteLabel: "host",
    });
  });

  test("keeps the one-time basic diagnostics opt-in strictly boolean and off by default", () => {
    expect(sanitizeInPageWidgetViewModel(model()).collectBasicDiagnosticsForNextCapture)
      .toBe(false);
    expect(sanitizeInPageWidgetViewModel(model({
      collectBasicDiagnosticsForNextCapture: true,
    })).collectBasicDiagnosticsForNextCapture).toBe(true);

    for (const value of [false, "true", 1, {}, [], null, undefined]) {
      expect(sanitizeInPageWidgetViewModel({
        ...model(),
        collectBasicDiagnosticsForNextCapture: value,
      } as unknown as InPageWidgetViewModel).collectBasicDiagnosticsForNextCapture)
      .toBe(false);
    }
  });

  test("keeps only an exact private troubleshooting summary", () => {
    const summary = privateDebugSummary();
    const sanitized = sanitizeInPageWidgetViewModel(model({ privateDebugSummary: summary }));
    expect(sanitized.privateDebugSummary).toEqual(summary);
    if (sanitized.privateDebugSummary?.device.status === "collected") {
      sanitized.privateDebugSummary.device.deviceClass = "mobile";
    }
    expect(summary.device).toMatchObject({ deviceClass: "desktop" });

    for (const privateDebugSummary of [
      { ...summary, captureId: "secret-capture" },
      { ...summary, origin: "https://secret.example.test" },
      { ...summary, network: { status: "not_requested" } },
      { ...summary, executionAuthority: { ...summary.executionAuthority, browserControl: true } },
      null,
      undefined,
    ]) {
      expect(sanitizeInPageWidgetViewModel({
        ...model(),
        privateDebugSummary,
      } as unknown as InPageWidgetViewModel).privateDebugSummary).toBeNull();
    }
  });

  test("sanitizes malformed lifecycle metadata to a non-actionable null state", () => {
    const valid = {
      state: "resolved",
      resolvedAt: "2026-08-31T00:00:00.000Z",
    } as const;
    expect(sanitizeInPageWidgetViewModel(model({
      targets: [{ itemId: "item-a", label: "A", name: "Target", annotationLifecycle: valid }],
    })).targets[0]?.annotationLifecycle).toEqual(valid);

    for (const annotationLifecycle of [
      undefined,
      null,
      { state: "resolved", resolvedAt: null },
      { state: "open", resolvedAt: "2026-08-31T00:00:00.000Z" },
      { state: "unknown", resolvedAt: null },
      { state: "resolved", resolvedAt: "not-a-date" },
      { state: "open", resolvedAt: null, extra: true },
      Object.create({ state: "resolved", resolvedAt: valid.resolvedAt }),
    ]) {
      const sanitized = sanitizeInPageWidgetViewModel({
        ...model(),
        targets: [{
          itemId: "item-a",
          label: "A",
          name: "Target",
          annotationLifecycle,
        }],
      } as unknown as InPageWidgetViewModel);
      expect(sanitized.targets[0]?.annotationLifecycle).toBeNull();
    }
  });

  test("sanitizes lifecycle control proposals without trusting malformed values", () => {
    const valid = lifecycleControlProposal();
    expect(sanitizeInPageWidgetViewModel(model({
      activeItemId: "item-a",
      lifecycleControlProposal: valid,
    })).lifecycleControlProposal).toEqual(valid);

    const getter = vi.fn(() => valid.fingerprint);
    const accessor = { ...valid };
    Object.defineProperty(accessor, "fingerprint", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const malformed = [
      undefined,
      { ...valid, operationId: undefined },
      { ...valid, extra: true },
      { ...valid, fingerprint: { value: valid.fingerprint } },
      { ...valid, expiresAt: { value: valid.expiresAt } },
      Object.create({ ...valid }),
      accessor,
    ];
    for (const lifecycleControlProposal of malformed) {
      expect(sanitizeInPageWidgetViewModel({
        ...model({ activeItemId: "item-a" }),
        lifecycleControlProposal,
      } as unknown as InPageWidgetViewModel).lifecycleControlProposal).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test("accepts only exact bounded clear-status operation ids", () => {
    const validOperationId = "o".repeat(128);
    expect(sanitizeInPageWidgetViewModel(model({
      clearStatus: { clearState: "pending", operationId: validOperationId },
    })).clearStatus).toEqual({
      clearState: "pending",
      operationId: validOperationId,
    });

    const inherited = Object.create({
      clearState: "pending",
      operationId: "inherited-operation",
    });
    const invalidStatuses = [
      inherited,
      { clearState: "pending", operationId: "   " },
      { clearState: "pending", operationId: " operation" },
      { clearState: "pending", operationId: "operation\u0007id" },
      { clearState: "pending", operationId: "o".repeat(129) },
      { clearState: "pending", operationId: "operation", extra: true },
    ];
    for (const clearStatus of invalidStatuses) {
      expect(sanitizeInPageWidgetViewModel({
        ...model(),
        clearStatus,
      } as unknown as InPageWidgetViewModel).clearStatus).toEqual({
        clearState: "idle",
        operationId: null,
      });
    }
  });

  test("fails closed for a revoked proxy without throwing", () => {
    const revoked = Proxy.revocable({
      clearState: "pending" as const,
      operationId: "revoked-operation",
    }, {});
    revoked.revoke();
    expect(sanitizeClearStatus(revoked.proxy)).toEqual({
      clearState: "idle",
      operationId: null,
    });
  });

  test("fails closed for transparent proxies, accessors, and missing structured clone", () => {
    const transparentProxy = new Proxy({
      clearState: "pending" as const,
      operationId: "proxy-operation",
    }, {});
    expect(sanitizeClearStatus(transparentProxy)).toEqual({
      clearState: "idle",
      operationId: null,
    });

    let getterCalls = 0;
    const accessorStatus = {};
    Object.defineProperties(accessorStatus, {
      clearState: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "pending";
        },
      },
      operationId: { enumerable: true, value: "accessor-operation" },
    });
    expect(sanitizeClearStatus(accessorStatus)).toEqual({
      clearState: "idle",
      operationId: null,
    });
    expect(getterCalls).toBe(0);

    const structuredCloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
    Object.defineProperty(globalThis, "structuredClone", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(sanitizeClearStatus({
        clearState: "pending",
        operationId: "no-clone-operation",
      })).toEqual({ clearState: "idle", operationId: null });
    } finally {
      if (structuredCloneDescriptor) {
        Object.defineProperty(globalThis, "structuredClone", structuredCloneDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "structuredClone");
      }
    }
  });
});

describe("createInPageWidgetView", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("renders a compact collapsed launcher without clipping status copy", () => {
    const onExpand = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "collapsed", bridgeState: "connected" }),
      callbacks: { onExpand },
    });
    document.body.append(view.element);

    const launcher = actionButton(view.element, "expand");
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(launcher.getAttribute("aria-label")).toContain("2 selected");
    expect(launcher.querySelector(".meanthis-brand-mark")).not.toBeNull();
    expect(launcher.querySelector(".meanthis-launcher-copy")).toBeNull();
    expect(surface(view.element).textContent).toContain("2");
    expect(launcher.getAttribute("aria-label")).toContain("connected");
    expect(IN_PAGE_WIDGET_CSS).toMatch(
      /\.meanthis-launcher \{[\s\S]*?width: 48px;[\s\S]*?height: 48px;[\s\S]*?border-radius: 50%;/u,
    );
    expect(IN_PAGE_WIDGET_CSS).toMatch(
      /\.meanthis-launcher \.meanthis-count \{[\s\S]*?top: 1px;[\s\S]*?right: 1px;[\s\S]*?min-width: 16px;[\s\S]*?height: 16px;/u,
    );
    expect(IN_PAGE_WIDGET_CSS).toMatch(
      /\.meanthis-workbar \{[\s\S]*?padding: 7px 12px;/u,
    );

    launcher.click();
    expect(onExpand).toHaveBeenCalledOnce();
  });

  test("auto-collapses only an idle workbar after pointer leave", () => {
    vi.useFakeTimers();
    const onCollapse = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "ready", activeItemId: null }),
      callbacks: { onCollapse },
    });
    document.body.append(view.element);

    view.element.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(299);
    expect(onCollapse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onCollapse).toHaveBeenCalledOnce();
    onCollapse.mockClear();

    view.update(model({ mode: "selecting", activeItemId: null }));
    view.element.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(300);
    expect(onCollapse).not.toHaveBeenCalled();

    view.update(model({ mode: "details", activeItemId: null }));
    view.element.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(300);
    expect(onCollapse).not.toHaveBeenCalled();

    view.update(model({ mode: "ready", activeItemId: null, clearConfirmationRequired: true }));
    view.element.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(300);
    expect(onCollapse).not.toHaveBeenCalled();

    view.dispose();
    vi.useRealTimers();
  });

  test("uses capture authority for the settings toggle instead of inferring it from layout", () => {
    const callbacks = { onStartSelection: vi.fn(), onStopSelection: vi.fn() };
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "details", selectionEnabled: true }),
      callbacks,
    });
    document.body.append(view.element);
    expect(actionButton(view.element, "toggle-selection").getAttribute("aria-pressed")).toBe("true");
    actionButton(view.element, "toggle-selection").click();
    expect(callbacks.onStopSelection).toHaveBeenCalledOnce();
    expect(callbacks.onStartSelection).not.toHaveBeenCalled();
    view.update(model({ mode: "details", selectionEnabled: false }));
    expect(actionButton(view.element, "toggle-selection").getAttribute("aria-pressed")).toBe("false");
    actionButton(view.element, "toggle-selection").click();
    expect(callbacks.onStartSelection).toHaveBeenCalledOnce();
    view.dispose();
  });

  test("renders a compact workbar whose primary controls call real product actions", () => {
    const callbacks = {
      onStopSelection: vi.fn(),
      onCopy: vi.fn(),
      onClear: vi.fn(),
      onOpenSettings: vi.fn(),
      onCollapse: vi.fn(),
    };
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "selecting" }),
      callbacks,
    });
    document.body.append(view.element);

    const panel = view.element.querySelector<HTMLElement>(".meanthis-panel");
    expect(panel?.dataset.layout).toBe("workbar");
    expect(view.element.querySelector('[role="toolbar"]')?.getAttribute("aria-label"))
      .toBe("Selection controls");
    const workbar = view.element.querySelector<HTMLElement>(".meanthis-workbar");
    expect(workbar?.querySelector(".meanthis-workbar-brand")).toBeNull();
    expect(workbar?.firstElementChild?.getAttribute("data-meanthis-action"))
      .toBe("toggle-selection");
    expect(actionButton(view.element, "collapse").parentElement?.classList)
      .toContain("meanthis-workbar-ending");
    expect(IN_PAGE_WIDGET_CSS).toContain(".meanthis-workbar-ending {");
    expect(IN_PAGE_WIDGET_CSS).not.toContain("margin-left: auto;");
    expect(IN_PAGE_WIDGET_CSS).toContain("width: max-content;");
    expect(IN_PAGE_WIDGET_CSS).toMatch(/\.meanthis-panel \{[\s\S]*?display: block;[\s\S]*?padding: 0;/u);
    expect(IN_PAGE_WIDGET_CSS).toMatch(
      /\.meanthis-panel\[data-layout="workbar"\] \{[\s\S]*?box-shadow: none;/u,
    );
    expect(actionButton(view.element, "toggle-selection").querySelector("img")?.getAttribute("src"))
      .toBe("./icons/pause.svg");
    const captureScope = actionButton(view.element, "capture-scope");
    expect(captureScope.querySelector("img")?.getAttribute("src"))
      .toBe("./icons/rectangle-group.svg");
    expect(captureScope.getAttribute("aria-label")).toBe("Capture scope");
    expect(captureScope.getAttribute("aria-expanded")).toBe("false");
    expect(actionButtons(view.element, "toggle-details")).toHaveLength(0);
    const copy = actionButton(view.element, "copy");
    expect(copy.querySelector("img")?.getAttribute("src"))
      .toBe("./icons/document-duplicate.svg");
    expect(copy.querySelector(".meanthis-workbar-count")?.textContent).toBe("2");
    expect(actionButton(view.element, "clear").querySelector("img")?.getAttribute("src"))
      .toBe("./icons/trash.svg");
    expect(actionButton(view.element, "open-settings").querySelector("img")?.getAttribute("src"))
      .toBe("./icons/settings.svg");
    expect(actionButton(view.element, "collapse").querySelector("img")?.getAttribute("src"))
      .toBe("./icons/x-mark.svg");

    actionButton(view.element, "toggle-selection").click();
    actionButton(view.element, "copy").click();
    actionButton(view.element, "clear").click();
    actionButton(view.element, "open-settings").click();
    actionButton(view.element, "collapse").click();

    expect(callbacks.onStopSelection).toHaveBeenCalledOnce();
    expect(callbacks.onCopy).toHaveBeenCalledOnce();
    expect(callbacks.onClear).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();
    expect(callbacks.onCollapse).toHaveBeenCalledOnce();
  });

  test("keeps capture-scope controls locked while a frame-scope transition is busy", () => {
    const callbacks = {
      onToggleFrameScopes: vi.fn(),
      onSelectFrameScope: vi.fn(),
    };
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "ready",
        busyAction: "frame-scope",
        frameScopeOpen: true,
        frameScopes: [
          {
            id: "scope-top",
            kind: "top",
            detail: "https://example.test/settings",
            depth: 0,
            current: true,
            selectable: true,
            itemCount: 3,
          },
          {
            id: "scope-child",
            kind: "embedded",
            detail: "https://frame.test/editor",
            depth: 1,
            current: false,
            selectable: true,
            itemCount: 4,
          },
        ],
      }),
      callbacks,
    });
    document.body.append(view.element);

    const toggle = actionButton(view.element, "capture-scope");
    const row = view.element.querySelector<HTMLButtonElement>("[role='treeitem']");
    expect(surface(view.element).getAttribute("aria-busy")).toBe("true");
    expect(toggle.disabled).toBe(true);
    expect(toggle.dataset.busy).toBe("true");
    expect(row?.disabled).toBe(true);

    toggle.click();
    row?.click();
    expect(callbacks.onToggleFrameScopes).not.toHaveBeenCalled();
    expect(callbacks.onSelectFrameScope).not.toHaveBeenCalled();
  });

  test("opens an anchored capture-scope tree and keeps opaque frame ids out of DOM", () => {
    const callbacks = {
      onToggleFrameScopes: vi.fn(),
      onSelectFrameScope: vi.fn(),
      onCloseFrameScopes: vi.fn(),
    };
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "ready",
        frameScopeOpen: true,
        frameScopes: [
          {
            id: "top-secret-scope",
            kind: "top",
            detail: "https://example.test/settings",
            depth: 0,
            current: false,
            selectable: true,
            itemCount: 3,
          },
          {
            id: "child-secret-scope",
            kind: "embedded",
            detail: "https://frame.test/editor",
            depth: 1,
            current: true,
            selectable: true,
            itemCount: 4,
          },
          {
            id: "nested-unavailable-scope",
            kind: "embedded",
            detail: "https://frame.test/unavailable",
            depth: 2,
            current: false,
            selectable: false,
            itemCount: 0,
          },
        ],
      }),
      callbacks,
    });
    document.body.append(view.element);

    const panel = view.element.querySelector<HTMLElement>(".meanthis-panel");
    const toggle = actionButton(view.element, "capture-scope");
    const tree = view.element.querySelector<HTMLElement>("[role='tree']");
    const rows = Array.from(view.element.querySelectorAll<HTMLButtonElement>("[role='treeitem']"));
    expect(panel?.dataset.layout).toBe("scope");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(tree?.getAttribute("aria-label")).toBe("Capture scope");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Top page");
    expect(rows[0]?.querySelector(".meanthis-frame-scope-count")?.textContent).toBe("3");
    expect(rows[1]?.textContent).toContain("Embedded frame");
    expect(rows[1]?.querySelector(".meanthis-frame-scope-count")?.textContent).toBe("4");
    expect(view.element.querySelector(".meanthis-frame-scope-heading")?.textContent)
      .toContain("7 across scopes");
    expect(rows[1]?.getAttribute("aria-level")).toBe("2");
    expect(rows[1]?.getAttribute("aria-current")).toBe("true");
    expect(rows[2]?.disabled).toBe(true);
    expect(rows[2]?.title).toBe("This frame is not available for element selection.");
    expect(view.element.outerHTML).not.toContain("child-secret-scope");

    rows[1]?.click();
    expect(callbacks.onSelectFrameScope).toHaveBeenCalledWith("child-secret-scope");
    const escaped = escape(rows[1]!);
    expect(callbacks.onCloseFrameScopes).toHaveBeenCalledOnce();
    expect(escaped.defaultPrevented).toBe(true);

    view.update(model({
      mode: "ready",
      frameScopeOpen: true,
      frameScopes: [
        {
          id: "top-secret-scope",
          kind: "top",
          detail: "https://example.test/settings",
          depth: 0,
          current: true,
          selectable: true,
          itemCount: 3,
        },
        {
          id: "child-secret-scope",
          kind: "embedded",
          detail: "https://frame.test/editor",
          depth: 1,
          current: false,
          selectable: true,
          itemCount: 4,
        },
      ],
      targets: [
        { itemId: "top-a", label: "1", name: "Top A" },
        { itemId: "top-b", label: "2", name: "Top B" },
        { itemId: "top-c", label: "3", name: "Top C" },
      ],
      activeItemId: "top-c",
    }));
    expect(actionButton(view.element, "copy").querySelector(".meanthis-workbar-count")?.textContent)
      .toBe("3");
    expect(view.element.querySelector(".meanthis-frame-scope-heading")?.textContent)
      .toContain("7 across scopes");

    view.update(model({
      mode: "ready",
      frameScopeOpen: true,
      frameScopes: [
        {
          id: "top-secret-scope",
          kind: "top",
          detail: "https://example.test/settings",
          depth: 0,
          current: true,
          selectable: true,
          itemCount: 0,
        },
        {
          id: "child-secret-scope",
          kind: "embedded",
          detail: "https://frame.test/editor",
          depth: 1,
          current: false,
          selectable: true,
          itemCount: 4,
        },
      ],
      targets: [],
      activeItemId: null,
    }));
    expect(actionButton(view.element, "clear").disabled).toBe(true);
    expect(actionButton(view.element, "clear").getAttribute("aria-label"))
      .toContain("0 selected");
  });

  test("hides capture scope when the runtime only exposes the fixed top document", () => {
    const sanitized = sanitizeInPageWidgetViewModel(model({
      mode: "ready",
      frameScopeOpen: true,
      frameScopes: [{
        id: "top-only",
        kind: "top",
        detail: "https://example.test/",
        depth: 0,
        current: true,
        selectable: true,
      }],
    }));
    expect(sanitized.frameScopeOpen).toBe(false);

    const view = createInPageWidgetView({ document, initialModel: sanitized });
    document.body.append(view.element);
    expect(actionButtons(view.element, "capture-scope")).toHaveLength(0);
    expect(view.element.querySelector("[role='tree']")).toBeNull();
  });

  test("keeps actionable controls gated until authoritative hydration completes", () => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "ready", readiness: "hydrating" }),
    });
    document.body.append(view.element);

    const panel = view.element.querySelector<HTMLElement>(".meanthis-panel");
    expect(panel?.getAttribute("aria-busy")).toBe("true");
    expect(actionButton(view.element, "toggle-selection").disabled).toBe(true);
    expect(actionButton(view.element, "capture-scope").disabled).toBe(true);
    expect(actionButton(view.element, "copy").disabled).toBe(true);
    expect(actionButton(view.element, "clear").disabled).toBe(true);

    view.update(model({ mode: "ready", readiness: "ready" }));
    expect(view.element.querySelector(".meanthis-panel")?.getAttribute("aria-busy")).toBe("false");
    expect(actionButton(view.element, "copy").disabled).toBe(false);
    expect(actionButton(view.element, "clear").disabled).toBe(false);
  });

  test("locks duplicate selection toggles but keeps collapse available to cancel a pending intent", () => {
    const onStartSelection = vi.fn();
    const onCollapse = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "ready",
        readiness: "ready",
        busyAction: "selection",
      }),
      callbacks: { onStartSelection, onCollapse },
    });
    document.body.append(view.element);

    const pending = actionButton(view.element, "toggle-selection");
    expect(pending.disabled).toBe(true);
    expect(pending.dataset.busy).toBe("true");
    pending.click();
    expect(onStartSelection).not.toHaveBeenCalled();
    const collapse = actionButton(view.element, "collapse");
    expect(collapse.disabled).toBe(false);
    collapse.click();
    expect(onCollapse).toHaveBeenCalledOnce();
    expect(actionButton(view.element, "open-settings").disabled).toBe(true);

    view.update(model({ mode: "ready", readiness: "ready", busyAction: null }));
    const settled = actionButton(view.element, "toggle-selection");
    expect(settled.disabled).toBe(false);
    expect(settled.dataset.busy).toBe("false");
    settled.click();
    expect(onStartSelection).toHaveBeenCalledOnce();
  });

  test("keeps clear-all confirmation inside the workbar without changing its width", () => {
    const onClear = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "ready",
        clearConfirmationRequired: true,
      }),
      callbacks: { onClear },
    });
    document.body.append(view.element);

    const panel = view.element.querySelector<HTMLElement>(".meanthis-panel");
    const clear = actionButton(view.element, "clear");
    expect(panel?.dataset.layout).toBe("workbar");
    expect(clear.dataset.confirm).toBe("true");
    expect(clear.getAttribute("aria-label"))
      .toBe("Select Clear again to remove references from the current page.");
    expect(clear.querySelector(".meanthis-clear-confirm-label")).toBeNull();
    expect(IN_PAGE_WIDGET_CSS).toContain('.meanthis-workbar-action[data-confirm="true"]');
    expect(IN_PAGE_WIDGET_CSS).not.toContain("min-width: 82px");

    clear.click();
    expect(onClear).toHaveBeenCalledOnce();
  });

  test("keeps a zero-target pending clear retry enabled and explicitly described", () => {
    const onClear = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "ready",
        targets: [],
        activeItemId: null,
        clearStatus: { clearState: "pending", operationId: "clear-op-1" },
      }),
      callbacks: { onClear },
    });
    document.body.append(view.element);

    const clear = actionButton(view.element, "clear");
    expect(clear.disabled).toBe(false);
    expect(clear.getAttribute("aria-label")).toBe("Retry clearing page annotations");
    expect(clear.title).toBe("Retry clearing page annotations");
    const describedBy = clear.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const pendingStatus = view.element.querySelector<HTMLElement>(`#${describedBy}`);
    expect(pendingStatus?.textContent)
      .toBe("Clearing page annotations is still pending. Retry to confirm completion.");
    expect(pendingStatus?.getAttribute("role")).toBe("status");
    expect(pendingStatus?.getAttribute("aria-live")).toBe("polite");

    clear.click();
    expect(onClear).toHaveBeenCalledOnce();

    view.update(model({
      targets: [],
      activeItemId: null,
      clearStatus: { clearState: "pending", operationId: "clear-op-1" },
      busyAction: "clear",
    }));
    expect(actionButton(view.element, "clear").disabled).toBe(true);

    view.update(model({
      targets: [],
      activeItemId: null,
      clearStatus: { clearState: "idle", operationId: null },
      busyAction: null,
    }));
    expect(actionButton(view.element, "clear").disabled).toBe(true);
  });

  test("expands details without duplicating the workbar controls", () => {
    const onOutputDetailChange = vi.fn();
    const onDisplayModeChange = vi.fn();
    const onReferenceScopeChange = vi.fn();
    const onOpenFullSidePanel = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        activeItemId: null,
        outputDetail: "compact",
        referenceScope: "page",
        pageTargetCount: 2,
        siteTargetCount: 4,
        siteLabel: "x.com",
      }),
      callbacks: {
        onOutputDetailChange,
        onDisplayModeChange,
        onReferenceScopeChange,
        onOpenFullSidePanel,
      },
    });
    document.body.append(view.element);

    const panel = view.element.querySelector<HTMLElement>(".meanthis-panel");
    const workbar = view.element.querySelector<HTMLElement>(".meanthis-workbar");
    expect(panel?.dataset.layout).toBe("details");
    expect(view.element.querySelectorAll(".meanthis-panel")).toHaveLength(1);
    expect(workbar?.parentElement).toBe(panel);
    expect(actionButton(view.element, "open-settings").getAttribute("aria-pressed")).toBe("true");
    expect(actionButtons(view.element, "toggle-selection")).toHaveLength(1);
    expect(actionButtons(view.element, "toggle-details")).toHaveLength(0);
    expect(actionButtons(view.element, "capture-scope")).toHaveLength(1);
    expect(actionButton(view.element, "copy").querySelector(".meanthis-workbar-count")?.textContent)
      .toBe("2");
    expect(view.element.querySelector(".meanthis-target-section")).not.toBeNull();
    const referenceScope = view.element.querySelector<HTMLSelectElement>(
      "[data-meanthis-action='reference-scope']",
    );
    expect(referenceScope?.value).toBe("page");
    expect(Array.from(referenceScope?.options ?? []).map((option) => option.textContent))
      .toEqual(["Current page · 2", "Entire x.com site · 4"]);
    expect(view.element.querySelector(".meanthis-reference-scope-help")?.textContent)
      .toBe("2 on other pages");
    referenceScope!.value = "site";
    referenceScope!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onReferenceScopeChange).toHaveBeenCalledWith("site");
    const outputDetail = view.element.querySelector<HTMLSelectElement>(
      "[data-meanthis-action='output-detail']",
    );
    expect(outputDetail?.value).toBe("compact");
    expect(Array.from(outputDetail?.options ?? []).map((option) => option.value))
      .toEqual(["compact", "standard", "detailed", "forensic"]);
    outputDetail!.value = "detailed";
    outputDetail!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onOutputDetailChange).toHaveBeenCalledWith("detailed");
    const displayGroup = view.element.querySelector<HTMLElement>("[role='radiogroup']");
    const displayModes = Array.from(displayGroup?.querySelectorAll<HTMLInputElement>(
      "input[type='radio']",
    ) ?? []);
    expect(displayModes.map((input) => input.value)).toEqual(["full", "hover", "markers", "hidden"]);
    expect(displayModes.find((input) => input.checked)?.value).toBe("hover");
    const hidden = displayModes.find((input) => input.value === "hidden")!;
    hidden.checked = true;
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onDisplayModeChange).toHaveBeenCalledWith("hidden");
    const openFullSidePanel = actionButton(view.element, "open-full-panel");
    expect(openFullSidePanel.localName).toBe("button");
    expect(openFullSidePanel.type).toBe("button");
    expect(openFullSidePanel.disabled).toBe(false);
    expect(openFullSidePanel.textContent).toContain("Open full side panel");
    openFullSidePanel.click();
    expect(onOpenFullSidePanel).toHaveBeenCalledWith({ isTrusted: false });
    expect(view.element.querySelector(".meanthis-bridge-controls")).not.toBeNull();

    view.update(model({
      mode: "details",
      activeItemId: null,
      busyAction: "side-panel",
    }));
    expect(actionButton(view.element, "open-full-panel").disabled).toBe(true);
    expect(actionButton(view.element, "open-full-panel").textContent)
      .toContain("Opening full side panel");
  });

  test("uses the selected reference scope for workbar count and clear labeling", () => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "ready",
        referenceScope: "site",
        pageTargetCount: 2,
        siteTargetCount: 4,
        siteLabel: "x.com",
        targets: [
          { itemId: "item-a", label: "1", name: "Current page A" },
          { itemId: "item-b", label: "2", name: "Current page B" },
          { itemId: "item-c", label: "3", name: "Other page C" },
          { itemId: "item-d", label: "4", name: "Other page D" },
        ],
      }),
    });
    document.body.append(view.element);

    expect(actionButton(view.element, "copy").querySelector(".meanthis-workbar-count")?.textContent)
      .toBe("4");
    expect(actionButton(view.element, "clear").title)
      .toBe("Clear references from the entire x.com site · 4 selected");
  });

  test("renders the one-time basic device context opt-in as an accessible switch", () => {
    const onCollectBasicDiagnosticsChange = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "details", activeItemId: null }),
      callbacks: { onCollectBasicDiagnosticsChange },
    });
    document.body.append(view.element);

    const section = view.element.querySelector<HTMLElement>(".meanthis-basic-diagnostics");
    const input = section?.querySelector<HTMLInputElement>(
      "[data-meanthis-action='collect-basic-diagnostics']",
    );
    expect(section?.textContent).toContain(
      "Add a private troubleshooting summary to the next capture",
    );
    expect(section?.textContent).toContain(
      "No page content, address, exact size, user agent, network, console, screenshot, or HAR.",
    );
    expect(input?.type).toBe("checkbox");
    expect(input?.getAttribute("role")).toBe("switch");
    expect(input?.checked).toBe(false);
    expect(input?.disabled).toBe(false);
    expect(input?.dataset.busy).toBe("false");
    expect(input?.dataset.commandRevision).toBe("0");
    expect(input?.getAttribute("aria-label")).toBe(
      DEFAULT_IN_PAGE_WIDGET_STRINGS.collectBasicDiagnosticsLabel,
    );
    expect(input?.getAttribute("aria-describedby")).toBe("meanthis-basic-diagnostics-help");

    input!.checked = true;
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onCollectBasicDiagnosticsChange).toHaveBeenLastCalledWith(true);
    expect(input?.getAttribute("aria-checked")).toBe("true");

    input!.checked = false;
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onCollectBasicDiagnosticsChange).toHaveBeenLastCalledWith(false);

    view.update(model({ mode: "details", activeItemId: null, busyAction: "diagnostics" }));
    const pending = view.element.querySelector<HTMLInputElement>(
      "[data-meanthis-action='collect-basic-diagnostics']",
    );
    expect(pending?.disabled).toBe(true);
    expect(pending?.dataset.busy).toBe("true");

    view.update(model({
      mode: "details",
      activeItemId: null,
      basicDiagnosticsCommandRevision: 1,
      busyAction: null,
    }));
    const settled = view.element.querySelector<HTMLInputElement>(
      "[data-meanthis-action='collect-basic-diagnostics']",
    );
    expect(settled?.disabled).toBe(false);
    expect(settled?.dataset.busy).toBe("false");
    expect(settled?.dataset.commandRevision).toBe("1");
  });

  test("previews a private troubleshooting summary and exposes its exact local copy state", () => {
    const onCopyPrivateDebugSummary = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        activeItemId: null,
        privateDebugSummary: privateDebugSummary(),
      }),
      callbacks: {
        onCollectBasicDiagnosticsChange: vi.fn(),
        onCopyPrivateDebugSummary,
      },
    });
    document.body.append(view.element);

    const preview = view.element.querySelector<HTMLElement>(".meanthis-private-debug-summary");
    const copy = actionButton(view.element, "copy-private-debug-summary");
    expect(preview?.textContent).toContain("Troubleshooting summary ready");
    expect(preview?.textContent).toContain("Not copied yet");
    expect(preview?.dataset.copyState).toBe("not_copied");
    expect(preview?.textContent).toContain("1 verified");
    expect(preview?.textContent).toContain("Desktop · Large viewport · No touch");
    expect(copy.disabled).toBe(false);
    copy.click();
    expect(onCopyPrivateDebugSummary).toHaveBeenCalledWith({ isTrusted: false });

    view.update(model({
      mode: "details",
      activeItemId: null,
      privateDebugSummary: privateDebugSummary(),
      busyAction: "diagnostics",
    }));
    expect(actionButton(view.element, "copy-private-debug-summary").disabled).toBe(true);

    view.update(model({
      mode: "details",
      activeItemId: null,
      privateDebugSummary: privateDebugSummary(),
      privateDebugSummaryCopied: true,
    }));
    const copiedPreview = view.element.querySelector<HTMLElement>(
      ".meanthis-private-debug-summary",
    );
    expect(copiedPreview?.dataset.copyState).toBe("copied");
    expect(copiedPreview?.textContent).toContain("Troubleshooting summary copied.");
  });

  test("does not expose a troubleshooting copy action without a summary or adapter", () => {
    const noSummary = createInPageWidgetView({
      document,
      initialModel: model({ mode: "details", activeItemId: null }),
      callbacks: {
        onCollectBasicDiagnosticsChange: vi.fn(),
        onCopyPrivateDebugSummary: vi.fn(),
      },
    });
    document.body.append(noSummary.element);
    expect(noSummary.element.querySelector("[data-meanthis-action='copy-private-debug-summary']"))
      .toBeNull();

    const noAdapter = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        activeItemId: null,
        privateDebugSummary: privateDebugSummary(),
      }),
    });
    document.body.append(noAdapter.element);
    expect(noAdapter.element.querySelector(".meanthis-private-debug-summary")).toBeNull();
  });

  test("hides the device-context opt-in when the adapter does not implement it", () => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "details", activeItemId: null }),
    });
    document.body.append(view.element);

    expect(view.element.querySelector(".meanthis-basic-diagnostics")).toBeNull();
    expect(view.element.querySelector("[data-meanthis-action='collect-basic-diagnostics']"))
      .toBeNull();
  });

  test("isolates annotation display radios from hostile light-DOM input styles", () => {
    const hostileStyle = document.createElement("style");
    hostileStyle.textContent = `
      input,
      input[type="radio"] {
        appearance: auto !important;
        display: block !important;
        position: fixed !important;
        width: 180px !important;
        height: 72px !important;
        margin: 31px !important;
      }
      label { display: block !important; padding: 40px !important; }
    `;
    document.head.append(hostileStyle);
    const onDisplayModeChange = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "details", displayMode: "hover" }),
      callbacks: { onDisplayModeChange },
    });
    document.body.append(view.element);
    try {
      const group = view.element.querySelector<HTMLElement>(
        ".meanthis-annotation-display-options",
      );
      const radios = Array.from(group?.querySelectorAll<HTMLInputElement>("input") ?? []);
      const full = radios.find((radio) => radio.value === "full")!;
      const option = full.closest<HTMLElement>("label")!;
      const style = getComputedStyle(full);
      const optionStyle = getComputedStyle(option);

      expect(radios).toHaveLength(4);
      expect(full.className).toBe("meanthis-annotation-display-input");
      expect(style.appearance).toBe("none");
      expect(style.display).toBe("inline-grid");
      expect(style.position).toBe("static");
      expect(style.width).toBe("14px");
      expect(style.height).toBe("14px");
      expect(style.margin).toBe("0px");
      expect(optionStyle.display).toBe("inline-flex");
      expect(optionStyle.padding).toBe("4px 6px");
      expect(full.getAttribute("role")).toBe("radio");
      expect(full.getAttribute("aria-label")).toBe("Full");
      full.focus();
      expect(document.activeElement).toBe(full);
      option.click();
      expect(full.checked).toBe(true);
      expect(onDisplayModeChange).toHaveBeenCalledWith("full");

      view.update(model({ mode: "details", readiness: "hydrating" }));
      expect(Array.from(view.element.querySelectorAll<HTMLInputElement>(
        ".meanthis-annotation-display-input",
      )).every((radio) => radio.disabled)).toBe(true);
    } finally {
      view.dispose();
      hostileStyle.remove();
    }
  });

  test("expands a compact workbar to surface errors instead of hiding them", () => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "selecting",
        status: { kind: "error", message: "Could not copy the current reference." },
      }),
    });
    document.body.append(view.element);

    expect(view.element.querySelector<HTMLElement>(".meanthis-panel")?.dataset.layout)
      .toBe("details");
    expect(view.element.querySelector('[role="alert"]')?.textContent)
      .toBe("Could not copy the current reference.");
  });

  test("renders the selection toolbar, A/B chips, and active target editor", () => {
    const callbacks = {
      onStartSelection: vi.fn(),
      onActivateTarget: vi.fn(),
      onTaskNoteChange: vi.fn(),
      onApplyShortcut: vi.fn(),
      onSave: vi.fn(),
      onCopy: vi.fn(),
      onCloseEditor: vi.fn(),
      onEditTarget: vi.fn(),
      onRemoveTarget: vi.fn(),
      onMoreTarget: vi.fn(),
    };
    const view = createInPageWidgetView({
      document,
      initialModel: model(),
      callbacks,
    });
    document.body.append(view.element);

    expect(view.element.querySelector('[role="toolbar"]')?.getAttribute("aria-label"))
      .toBe("Selection controls");
    const chips = actionButtons(view.element, "activate-target");
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining("A"),
      expect.stringContaining("B"),
    ]);
    expect(chips[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(chips[0]?.getAttribute("aria-pressed")).toBe("false");

    actionButton(view.element, "toggle-selection").click();
    chips[0]?.click();
    actionButton(view.element, "edit-target").click();
    actionButton(view.element, "remove-target").click();
    actionButton(view.element, "more-target").click();
    expect(callbacks.onStartSelection).toHaveBeenCalledOnce();
    expect(callbacks.onActivateTarget).toHaveBeenCalledWith("item-a");
    expect(callbacks.onEditTarget).toHaveBeenCalledWith("item-b");
    expect(callbacks.onRemoveTarget).toHaveBeenCalledWith("item-b");
    expect(callbacks.onMoreTarget).toHaveBeenCalledWith("item-b");

    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.getAttribute("aria-label")).toBe("Task note for target B");
    expect(textarea?.value).toBe("Match the primary action.");
    textarea!.value = "Use the same spacing.";
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(callbacks.onTaskNoteChange).toHaveBeenLastCalledWith(
      "item-b",
      "Use the same spacing.",
    );

    actionButton(view.element, "apply-shortcut").click();
    expect(textarea?.value).toBe("Keep the same spacing.");
    expect(callbacks.onApplyShortcut).toHaveBeenCalledWith(
      "item-b",
      "same-spacing",
      "Keep the same spacing.",
    );
    expect(callbacks.onTaskNoteChange).toHaveBeenLastCalledWith(
      "item-b",
      "Keep the same spacing.",
    );

    actionButton(view.element, "save").click();
    actionButton(view.element, "copy").click();
    actionButton(view.element, "close-editor").click();
    expect(callbacks.onSave).toHaveBeenCalledWith("item-b", "Keep the same spacing.");
    expect(callbacks.onCopy).toHaveBeenCalledWith();
    expect(callbacks.onCloseEditor).toHaveBeenCalledWith("item-b");
  });

  test("renders resolved text and exposes Mark resolved/Reopen lifecycle controls", () => {
    const onSetAnnotationLifecycle = vi.fn();
    const resolvedView = createInPageWidgetView({
      document,
      initialModel: model({
        targets: [{
          itemId: "item-a",
          label: "A",
          name: "Resolved target",
          annotationLifecycle: {
            state: "resolved",
            resolvedAt: "2026-08-31T00:00:00.000Z",
          },
        }],
        activeItemId: "item-a",
      }),
      callbacks: { onSetAnnotationLifecycle },
    });
    document.body.append(resolvedView.element);

    expect(resolvedView.element.querySelector<HTMLElement>('.meanthis-target-state')?.textContent)
      .toBe("Resolved");
    const reopen = actionButton(resolvedView.element, "set-annotation-lifecycle");
    expect(reopen.textContent).toContain("Reopen");
    expect(reopen.disabled).toBe(false);
    reopen.click();
    expect(onSetAnnotationLifecycle).toHaveBeenCalledWith(
      "item-a",
      "open",
      { isTrusted: false } satisfies InPageWidgetInteraction,
    );

    resolvedView.update(model({
      targets: [{
        itemId: "item-a",
        label: "A",
        name: "Open target",
        annotationLifecycle: { state: "open", resolvedAt: null },
      }],
      activeItemId: "item-a",
      busyAction: "lifecycle",
    }));
    const markResolved = actionButton(resolvedView.element, "set-annotation-lifecycle");
    expect(resolvedView.element.querySelector('.meanthis-target-state')).toBeNull();
    expect(markResolved.textContent).toContain("Mark resolved");
    expect(markResolved.disabled).toBe(true);
    markResolved.click();
    expect(onSetAnnotationLifecycle).toHaveBeenCalledTimes(1);

    resolvedView.update(model({
      targets: [{
        itemId: "item-a",
        label: "A",
        name: "Open target",
        annotationLifecycle: { state: "open", resolvedAt: null },
      }],
      activeItemId: "item-a",
      busyAction: null,
    }));
    const openEditorControls = actionButtons(resolvedView.element, "set-annotation-lifecycle");
    expect(openEditorControls).toHaveLength(1);
    expect(openEditorControls[0]?.textContent).toContain("Mark resolved");
    expect(actionButton(resolvedView.element, "copy").disabled).toBe(false);
    expect(resolvedView.element.querySelector("textarea.meanthis-task-note")).not.toBeNull();

    resolvedView.dispose();
  });

  test("renders an active-target Agent lifecycle proposal with bounded metadata", () => {
    const candidate = lifecycleControlProposal();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        activeItemId: "item-a",
        lifecycleControlProposal: candidate,
      }),
    });
    document.body.append(view.element);

    const card = view.element.querySelector<HTMLElement>(
      ".meanthis-lifecycle-control-proposal",
    );
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Agent lifecycle proposal");
    expect(card?.textContent).toContain("open → resolved");
    expect(card?.textContent).toContain(candidate.fingerprint.slice(0, 32));
    expect(card?.textContent).toContain("…");
    expect(card?.textContent).toContain(candidate.expiresAt);
    expect(actionButton(card!, "approve-lifecycle-control-proposal").textContent)
      .toContain("Approve");
    expect(actionButton(card!, "reject-lifecycle-control-proposal").textContent)
      .toContain("Reject");

    view.update(model({
      activeItemId: "item-b",
      lifecycleControlProposal: candidate,
    }));
    expect(view.element.querySelector(".meanthis-lifecycle-control-proposal")).toBeNull();
    view.dispose();
  });

  test("passes proposal binding and the synthetic event trust witness to approve/reject callbacks", () => {
    const candidate = lifecycleControlProposal();
    const onApproveLifecycleControlProposal = vi.fn();
    const onRejectLifecycleControlProposal = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        activeItemId: "item-a",
        lifecycleControlProposal: candidate,
      }),
      callbacks: {
        onApproveLifecycleControlProposal,
        onRejectLifecycleControlProposal,
      },
    });
    document.body.append(view.element);

    const approve = actionButton(view.element, "approve-lifecycle-control-proposal");
    const trustedEvent = new MouseEvent("click", { bubbles: true });
    approve.dispatchEvent(trustedEvent);
    expect(onApproveLifecycleControlProposal).toHaveBeenCalledWith(
      candidate.operationId,
      candidate.fingerprint,
      { isTrusted: trustedEvent.isTrusted } satisfies InPageWidgetInteraction,
    );

    actionButton(view.element, "reject-lifecycle-control-proposal").click();
    expect(onRejectLifecycleControlProposal).toHaveBeenCalledWith(
      candidate.operationId,
      candidate.fingerprint,
      { isTrusted: false } satisfies InPageWidgetInteraction,
    );
    view.dispose();
  });

  test("does not render or invoke proposal callbacks for malformed or wrong-target proposals", () => {
    const candidate = lifecycleControlProposal();
    const onApproveLifecycleControlProposal = vi.fn();
    const onRejectLifecycleControlProposal = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        activeItemId: "item-a",
        lifecycleControlProposal: candidate,
      }),
      callbacks: {
        onApproveLifecycleControlProposal,
        onRejectLifecycleControlProposal,
      },
    });
    document.body.append(view.element);

    const candidates = [
      { ...candidate, itemId: "item-b" },
      { ...candidate, operationId: undefined },
      { ...candidate, fingerprint: undefined },
      { ...candidate, nextState: "open" },
      { ...candidate, extra: { nested: true } },
    ];
    for (const lifecycleControlProposal of candidates) {
      view.update(model({ activeItemId: "item-a", lifecycleControlProposal } as Partial<InPageWidgetViewModel>));
      expect(view.element.querySelector(".meanthis-lifecycle-control-proposal")).toBeNull();
      expect(view.element.querySelector("[data-meanthis-action='approve-lifecycle-control-proposal']"))
        .toBeNull();
      expect(view.element.querySelector("[data-meanthis-action='reject-lifecycle-control-proposal']"))
        .toBeNull();
    }
    expect(onApproveLifecycleControlProposal).not.toHaveBeenCalled();
    expect(onRejectLifecycleControlProposal).not.toHaveBeenCalled();
    view.dispose();
  });

  test("does not render or dispatch lifecycle controls for legacy targets", () => {
    const onSetAnnotationLifecycle = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({ activeItemId: "item-b" }),
      callbacks: { onSetAnnotationLifecycle },
    });
    document.body.append(view.element);

    expect(view.element.querySelector("[data-meanthis-action='set-annotation-lifecycle']"))
      .toBeNull();
    expect(view.element.querySelector(".meanthis-target-state")).toBeNull();
    expect(onSetAnnotationLifecycle).not.toHaveBeenCalled();
    view.dispose();
  });

  test("requires an explicit disclosure acknowledgement before first selection", () => {
    const onAcknowledgeDisclosure = vi.fn();
    const onStartSelection = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        activeItemId: null,
        disclosureRequired: true,
        readiness: "hydrating",
      }),
      callbacks: { onAcknowledgeDisclosure, onStartSelection },
    });
    document.body.append(view.element);

    expect(view.element.querySelector(".meanthis-disclosure")?.textContent)
      .toContain("Before your first capture");
    const selection = actionButton(view.element, "toggle-selection");
    expect(selection.disabled).toBe(true);
    selection.click();
    expect(onStartSelection).not.toHaveBeenCalled();
    expect(onAcknowledgeDisclosure).not.toHaveBeenCalled();

    const acknowledge = actionButton(view.element, "acknowledge-disclosure");
    expect(acknowledge.disabled).toBe(true);
    acknowledge.click();
    expect(onAcknowledgeDisclosure).not.toHaveBeenCalled();

    view.update(model({
      mode: "details",
      activeItemId: null,
      disclosureRequired: true,
      readiness: "ready",
    }));
    actionButton(view.element, "acknowledge-disclosure").click();
    expect(onAcknowledgeDisclosure).toHaveBeenCalledOnce();

    view.update(model({
      mode: "details",
      activeItemId: null,
      disclosureRequired: true,
      busyAction: "disclosure",
    }));
    expect(actionButton(view.element, "acknowledge-disclosure").disabled).toBe(true);
    expect(actionButton(view.element, "acknowledge-disclosure").textContent)
      .toContain("Saving acknowledgement");
  });

  test("offers narrow bridge controls without exposing invitation text in DOM attributes", () => {
    const callbacks = {
      onCreateInvitation: vi.fn(),
      onRefreshConnection: vi.fn(),
      onDisconnect: vi.fn(),
      onCopyInvitation: vi.fn(),
    };
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        activeItemId: null,
        bridgeState: "disconnected",
      }),
      callbacks,
    });
    document.body.append(view.element);

    actionButton(view.element, "create-invitation").click();
    expect(callbacks.onCreateInvitation).toHaveBeenCalledOnce();

    view.update(model({
      mode: "details",
      activeItemId: null,
      bridgeState: "disconnected",
      busyAction: "connect",
    }));
    expect(actionButton(view.element, "create-invitation").disabled).toBe(true);
    expect(actionButton(view.element, "create-invitation").textContent)
      .toContain("Creating invitation");

    const invitation = "meanthis://invite?secret=formal-user-handoff";
    view.update(model({
      mode: "details",
      activeItemId: null,
      bridgeState: "pending",
      bridgeInvitationRemainingSeconds: 65,
      connectionRequestText: invitation,
    }));
    expect(view.element.querySelector(".meanthis-bridge-help")?.textContent)
      .toContain("01:05");
    expect(view.element.querySelector<HTMLTextAreaElement>(".meanthis-invitation")?.value)
      .toBe(invitation);
    actionButton(view.element, "copy-invitation").click();
    actionButton(view.element, "refresh-connection").click();
    expect(callbacks.onCopyInvitation).toHaveBeenCalledWith(invitation);
    expect(callbacks.onRefreshConnection).toHaveBeenCalledOnce();
    for (const element of view.element.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain(invitation);
      }
    }

    view.update(model({
      mode: "details",
      activeItemId: null,
      bridgeState: "connected",
      busyAction: "disconnect",
    }));
    expect(actionButton(view.element, "disconnect").disabled).toBe(true);
    expect(actionButton(view.element, "disconnect").textContent).toContain("Disconnecting");
    view.update(model({
      mode: "details",
      activeItemId: null,
      bridgeState: "connected",
      bridgeSharedTargetCount: 3,
      bridgeSharedSequence: 9,
    }));
    expect(view.element.querySelector(".meanthis-bridge-help")?.textContent)
      .toContain("3 selected elements");
    expect((view.element.querySelector(".meanthis-bridge-controls") as HTMLElement).dataset)
      .toMatchObject({ sharedTargetCount: "3", sharedSequence: "9" });
    actionButton(view.element, "disconnect").click();
    expect(callbacks.onDisconnect).toHaveBeenCalledOnce();
  });

  test.each([
    ["waiting", "Waiting for the Agent client to retrieve the current share."],
    ["current", "The Agent client confirmed retrieval of the current share."],
    ["unavailable", "Unable to confirm whether the Agent client retrieved the current share."],
  ] as const)("renders the read acknowledgement state %s with stable widget selectors", (state, text) => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        bridgeState: "connected",
        bridgeSharedSequence: 4,
        bridgeReadAcknowledgementState: state,
      }),
    });
    document.body.append(view.element);

    const acknowledgement = view.element.querySelector<HTMLElement>(
      ".meanthis-bridge-read-acknowledgement",
    );
    const limitations = view.element.querySelector<HTMLElement>(
      ".meanthis-bridge-read-acknowledgement-limitations",
    );
    expect(acknowledgement).not.toBeNull();
    expect(acknowledgement?.dataset.state).toBe(state);
    expect(acknowledgement?.dataset.readAcknowledgementState).toBe(state);
    expect(acknowledgement?.dataset.sharedSequence).toBe("4");
    expect(acknowledgement?.dataset.meanthisBridgeReadAcknowledgement).toBe("true");
    expect(acknowledgement?.getAttribute("role")).toBe("status");
    expect(acknowledgement?.getAttribute("aria-live")).toBe("polite");
    expect(acknowledgement?.textContent).toBe(text);
    expect(limitations?.dataset.state).toBe(state);
    expect(limitations?.dataset.readAcknowledgementState).toBe(state);
    expect(limitations?.dataset.sharedSequence).toBe("4");
    expect(limitations?.dataset.meanthisBridgeReadAcknowledgementLimitations).toBe("true");
    expect(limitations?.textContent)
      .toBe("This does not mean the Agent understood or executed it.");
    expect(acknowledgement?.textContent).not.toMatch(/digest|captureId|path|instance-/i);
  });

  test("does not render an acknowledgement without a published sequence", () => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "details",
        bridgeState: "connected",
        bridgeReadAcknowledgementState: "current",
      }),
    });
    document.body.append(view.element);

    expect(view.element.querySelector(".meanthis-bridge-read-acknowledgement")).toBeNull();
    expect(view.element.querySelector(".meanthis-bridge-read-acknowledgement-limitations"))
      .toBeNull();
  });

  test("requests stop while selecting and disables busy actions", () => {
    const onStopSelection = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        mode: "selecting",
        bridgeState: "pending",
        status: { kind: "info", message: "Preparing current page references" },
      }),
      callbacks: { onStopSelection },
    });
    document.body.append(view.element);

    const toggle = actionButton(view.element, "toggle-selection");
    expect(toggle.getAttribute("aria-label")).toBe("Stop selecting");
    expect(toggle.querySelector("img")?.getAttribute("src")).toBe("./icons/pause.svg");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(view.element.querySelector(".meanthis-workbar-brand")).toBeNull();

    toggle.click();
    expect(onStopSelection).toHaveBeenCalledOnce();

    view.update(model({ targets: [], busyAction: null }));
    expect(actionButton(view.element, "copy").disabled).toBe(true);
    expect(actionButton(view.element, "copy").dataset.busy).toBe("false");

    view.update(model({ busyAction: "copy" }));
    expect(actionButton(view.element, "copy").disabled).toBe(true);
    expect(actionButton(view.element, "copy").dataset.busy).toBe("true");
    expect(IN_PAGE_WIDGET_CSS).toContain("button:disabled:not([data-busy=\"true\"])");
    expect(IN_PAGE_WIDGET_CSS).toContain("cursor: not-allowed");
    expect(IN_PAGE_WIDGET_CSS).toContain("button:disabled[data-busy=\"true\"]");
    expect(IN_PAGE_WIDGET_CSS).toContain("cursor: progress");
  });

  test("never parses model text as markup or places opaque ids in DOM attributes", () => {
    const view = createInPageWidgetView({
      document,
      initialModel: model({
        targets: [{
          itemId: "secret-item-id",
          label: "A",
          name: '<img data-secret="true" src=x>',
        }],
        activeItemId: "secret-item-id",
        taskNote: "<script>secret()</script>",
      }),
    });
    document.body.append(view.element);

    const images = view.element.querySelectorAll("img");
    expect(images.length).toBeGreaterThan(0);
    expect(Array.from(images).every((image) => image.getAttribute("src")?.startsWith("./icons/")))
      .toBe(true);
    expect(view.element.querySelector("script")).toBeNull();
    expect(surface(view.element).textContent).toContain('<img data-secret="true" src=x>');
    expect(view.element.querySelector("textarea")?.value).toBe("<script>secret()</script>");
    for (const element of view.element.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.value).not.toContain("secret-item-id");
      }
    }
  });

  test("keeps the connected task editor and selection during input and status refreshes", () => {
    let state = model({ taskNote: "alpha beta" });
    const view = createInPageWidgetView({ document, initialModel: state, callbacks: {
      onTaskNoteChange: (_id, note) => {
        state = { ...state, taskNote: note };
        view.update(state);
      },
    } });
    document.body.append(view.element);
    const textarea = view.element.querySelector<HTMLTextAreaElement>(".meanthis-task-note")!;
    textarea.focus();
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => records.forEach((record) => removed.push(...record.removedNodes)));
    observer.observe(view.element, { childList: true, subtree: true });
    textarea.setSelectionRange(5, 5);
    textarea.setRangeText("!", 5, 5, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(view.element.querySelector(".meanthis-task-note")).toBe(textarea);
    expect(textarea.selectionStart).toBe(6);
    textarea.setSelectionRange(7, 11, "backward");
    textarea.scrollTop = 23;
    const valueSetter = vi.spyOn(textarea, "value", "set");
    view.update({ ...state, bridgeState: "pending", status: { kind: "info", message: "Refreshing" } });
    expect(valueSetter).not.toHaveBeenCalled();
    expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection, textarea.scrollTop])
      .toEqual([7, 11, "backward", 23]);
    expect(document.activeElement).toBe(textarea);
    textarea.setRangeText("gamma", 7, 11, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.taskNote).toBe("alpha! gamma");
    view.update({ ...state, taskNote: "External replacement", targets: [
      { itemId: "item-b", label: "C", name: "Renamed target" },
    ] });
    expect(view.element.querySelector(".meanthis-task-note")).toBe(textarea);
    expect(textarea.value).toBe("External replacement");
    expect(textarea.getAttribute("aria-label")).toBe("Task note for target C");
    observer.takeRecords().forEach((record) => removed.push(...record.removedNodes));
    expect(removed.some((node) => node === textarea || node.contains(textarea))).toBe(false);
    observer.disconnect();
    view.dispose();
  });

  test("preserves composing text on refresh but resets it on target or mode changes", () => {
    const onTaskNoteChange = vi.fn();
    const onCloseEditor = vi.fn();
    const view = createInPageWidgetView({ document, initialModel: model(), callbacks: { onTaskNoteChange, onCloseEditor } });
    document.body.append(view.element);
    const textarea = view.element.querySelector<HTMLTextAreaElement>(".meanthis-task-note")!;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "输入";
    view.update(model({ bridgeState: "pending" }));
    expect(view.element.querySelector(".meanthis-task-note")).toBe(textarea);
    expect(textarea.value).toBe("输入");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    escape(textarea);
    expect(onTaskNoteChange).not.toHaveBeenCalled();
    expect(onCloseEditor).not.toHaveBeenCalled();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onTaskNoteChange).toHaveBeenLastCalledWith("item-b", "输入");
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.update(model({ activeItemId: "item-a", taskNote: "New target" }));
    const next = view.element.querySelector<HTMLTextAreaElement>(".meanthis-task-note")!;
    expect(next).not.toBe(textarea);
    expect(next.value).toBe("New target");
    next.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onTaskNoteChange).toHaveBeenCalledTimes(1);
    escape(next);
    expect(onCloseEditor).not.toHaveBeenCalled();
    next.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    escape(next);
    expect(onCloseEditor).toHaveBeenCalledWith("item-a");
    view.update(model({ mode: "details" }));
    view.update(model({ taskNote: "Reopened" }));
    expect(view.element.querySelector<HTMLTextAreaElement>(".meanthis-task-note")!.value).toBe("Reopened");
    view.dispose();
  });

  test("handles Escape by state while ignoring IME composition", () => {
    const callbacks = {
      onCloseEditor: vi.fn(),
      onStopSelection: vi.fn(),
      onOpenSettings: vi.fn(),
      onCollapse: vi.fn(),
    };
    const view = createInPageWidgetView({ document, initialModel: model(), callbacks });
    document.body.append(view.element);
    const textarea = view.element.querySelector<HTMLTextAreaElement>("textarea")!;

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const composingEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    textarea.dispatchEvent(composingEscape);
    expect(callbacks.onCloseEditor).not.toHaveBeenCalled();
    expect(composingEscape.defaultPrevented).toBe(false);

    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const editorEscape = escape(textarea);
    expect(callbacks.onCloseEditor).toHaveBeenCalledWith("item-b");
    expect(editorEscape.defaultPrevented).toBe(true);

    view.update(model({ mode: "selecting" }));
    const selectingEscape = escape(actionButton(view.element, "toggle-selection"));
    expect(callbacks.onStopSelection).toHaveBeenCalledOnce();
    expect(selectingEscape.defaultPrevented).toBe(true);

    view.update(model({ mode: "details", activeItemId: null }));
    const detailsEscape = escape(actionButton(view.element, "open-settings"));
    expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();
    expect(callbacks.onCollapse).not.toHaveBeenCalled();
    expect(detailsEscape.defaultPrevented).toBe(true);

    view.update(model({ mode: "ready", activeItemId: null }));
    const readyEscape = escape(actionButton(view.element, "toggle-selection"));
    expect(callbacks.onCollapse).toHaveBeenCalledOnce();
    expect(readyEscape.defaultPrevented).toBe(true);
  });

  test.each([true, false])("shows a separate recovery draft with targets=%s", (hasTarget) => {
    const onDiscardRecovery = vi.fn();
    const onTaskNoteChange = vi.fn();
    const state = model({ mode: hasTarget ? "editing" : "ready", targets: hasTarget ? model().targets : [],
      activeItemId: hasTarget ? "item-b" : null, recoveryDraft: "Lost target\n完整草稿", taskNote: "Canonical note" });
    const view = createInPageWidgetView({ document, initialModel: state, callbacks: { onDiscardRecovery, onTaskNoteChange } });
    document.body.append(view.element);
    const draft = view.element.querySelector<HTMLTextAreaElement>(".meanthis-recovery-draft")!;
    expect(draft.value).toBe("Lost target\n完整草稿");
    expect(draft.readOnly).toBe(true);
    expect(draft.getAttribute("aria-label")).toBe("Unsaved task note");
    if (hasTarget) expect(view.element.querySelector<HTMLTextAreaElement>(".meanthis-task-note")!.value).toBe("Canonical note");
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onTaskNoteChange).not.toHaveBeenCalled();
    actionButton(view.element, "discard-recovery").click();
    expect(onDiscardRecovery).toHaveBeenCalledOnce();
    view.update({ ...state, recoveryDraft: null });
    expect(view.element.querySelector(".meanthis-recovery-draft")).toBeNull();
    view.dispose();
  });

  test("preserves allowed multiline recovery text without trimming or assigning it to taskNote", () => {
    const draft = `  start\r\n${"中文 ".repeat(1000)}\nend  `;
    const sanitized = sanitizeInPageWidgetViewModel(model({ recoveryDraft: draft, taskNote: "Current item" }));
    expect(sanitized.recoveryDraft).toBe(draft.replace(/\r\n/g, "\n"));
    expect(sanitized.taskNote).toBe("Current item");
  });

  test("restores recovery selection only while the same draft remains", () => {
    const state = model({ recoveryDraft: "first line\nsecond line" });
    const view = createInPageWidgetView({ document, initialModel: state });
    document.body.append(view.element);
    const draft = view.element.querySelector<HTMLTextAreaElement>(".meanthis-recovery-draft")!;
    draft.focus();
    draft.setSelectionRange(2, 15, "backward");
    view.update({ ...state, siteTargetCount: 5 });
    const refreshed = view.element.querySelector<HTMLTextAreaElement>(".meanthis-recovery-draft")!;
    expect(document.activeElement).toBe(refreshed);
    expect([refreshed.selectionStart, refreshed.selectionEnd, refreshed.selectionDirection]).toEqual([2, 15, "backward"]);
    view.update({ ...state, recoveryDraft: "Different recovery" });
    const changed = view.element.querySelector<HTMLTextAreaElement>(".meanthis-recovery-draft")!;
    expect([changed.selectionStart, changed.selectionEnd]).not.toEqual([2, 15]);
    view.update({ ...state, recoveryDraft: null });
    expect(view.element.querySelector(".meanthis-recovery-draft")).toBeNull();
    view.dispose();
  });

  test("keeps the settings scrollbar and viewport during bridge countdown updates", () => {
    const state = model({ mode: "details", bridgeState: "pending", bridgeInvitationRemainingSeconds: 65 });
    const view = createInPageWidgetView({ document, initialModel: state });
    document.body.append(view.element);
    const panel = view.element.querySelector<HTMLElement>(".meanthis-panel")!;
    const targets = view.element.querySelector<HTMLElement>(".meanthis-target-list")!;
    actionButton(view.element, "open-settings").focus();
    panel.scrollTop = 240;
    targets.scrollLeft = 90;
    view.update({ ...state, bridgeInvitationRemainingSeconds: 64 });
    expect(view.element.querySelector(".meanthis-panel")).toBe(panel);
    expect(panel.scrollTop).toBe(240);
    expect(view.element.querySelector<HTMLElement>(".meanthis-target-list")!.scrollLeft).toBe(90);
    expect(document.activeElement).toBe(actionButton(view.element, "open-settings"));
    view.update({ ...state, bridgeState: "connected", bridgeInvitationRemainingSeconds: null });
    expect(view.element.querySelector(".meanthis-panel")).toBe(panel);
    expect(panel.scrollTop).toBe(240);
    view.update(model({ mode: "ready" }));
    view.update(state);
    expect(view.element.querySelector<HTMLElement>(".meanthis-panel")!.scrollTop).toBe(0);
    view.dispose();
  });

  test("provides deterministic focus and preserves it across controlled updates", () => {
    const view = createInPageWidgetView({ document, initialModel: model() });
    document.body.append(view.element);

    view.focus();
    expect(document.activeElement).toBe(view.element.querySelector("textarea"));

    view.update(model({ status: { kind: "success", message: "Saved" } }));
    expect(document.activeElement).toBe(view.element.querySelector("textarea"));

    view.update(model({ mode: "collapsed" }));
    const launcher = actionButton(view.element, "expand");
    launcher.focus();
    view.update(model({ mode: "ready", activeItemId: null }));
    expect(document.activeElement).toBe(actionButton(view.element, "toggle-selection"));
  });

  test("removes delegated interactions when disposed", () => {
    const onExpand = vi.fn();
    const view = createInPageWidgetView({
      document,
      initialModel: model({ mode: "collapsed" }),
      callbacks: { onExpand },
    });
    document.body.append(view.element);
    const launcher = actionButton(view.element, "expand");

    view.dispose();
    launcher.click();

    expect(view.element.isConnected).toBe(false);
    expect(onExpand).not.toHaveBeenCalled();
  });

  test("creates and controls the view in the supplied extension-frame document realm", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    if (!frameDocument) throw new Error("Missing frame document");
    const onExpand = vi.fn();
    const view = createInPageWidgetView({
      document: frameDocument,
      initialModel: model({ mode: "collapsed" }),
      callbacks: { onExpand },
    });
    frameDocument.body.append(view.element);

    expect(view.element.ownerDocument).toBe(frameDocument);
    actionButton(view.element, "expand").click();
    expect(onExpand).toHaveBeenCalledOnce();

    view.update(model());
    view.focus();
    expect(frameDocument.activeElement).toBe(view.element.querySelector("textarea"));
  });
});

describe("IN_PAGE_WIDGET_CSS", () => {
  test("keeps the dark widget responsive and honors accessibility preferences", () => {
    expect(IN_PAGE_WIDGET_CSS).toContain("color-scheme: dark");
    expect(IN_PAGE_WIDGET_CSS).toContain("@media (max-width: 380px)");
    expect(IN_PAGE_WIDGET_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(IN_PAGE_WIDGET_CSS).toContain("@media (forced-colors: active)");
    expect(IN_PAGE_WIDGET_CSS).not.toContain("url(");
  });

  test("shows workbar keyboard focus as an internal dot instead of a button border", () => {
    expect(IN_PAGE_WIDGET_CSS).toContain(".meanthis-workbar-action:focus-visible {");
    expect(IN_PAGE_WIDGET_CSS).toContain(".meanthis-workbar-action:focus-visible::after {");
    expect(IN_PAGE_WIDGET_CSS).toContain("background: #b0a6ff;");
    expect(IN_PAGE_WIDGET_CSS).not.toContain(`.meanthis-workbar-action:focus-visible {
  outline: none;
  border-color:`);
  });
});

describe("createInPageWidgetStrings", () => {
  test("builds every visible widget label from localized messages with safe fallbacks", () => {
    const translated = createInPageWidgetStrings((key, values) => ({
      in_page_widget_region_label: "页面引用",
      in_page_widget_open_label: `打开，${values?.count} 个，${values?.state}`,
      in_page_widget_copy_succeeded: `已复制 ${values?.count} 个。`,
      request_copied: "连接邀请已复制。请粘贴给本地 Agent，由它接受连接。",
      in_page_widget_task_note_label: `目标 ${values?.label} 的说明`,
      in_page_widget_shortcut_below_note: `将 ${values?.label} 放在下方。`,
      in_page_widget_annotation_resolved: "批注已解决。",
      in_page_widget_annotation_reopened: "批注已重新打开。",
      in_page_widget_annotation_lifecycle_unconfirmed: "批注状态未确认。",
      in_page_widget_lifecycle_control_proposal: "Agent 生命周期提案",
      in_page_widget_lifecycle_control_proposal_fingerprint: `指纹：${values?.fingerprint}`,
      in_page_widget_lifecycle_control_proposal_transition:
        `转换：${values?.expected} → ${values?.next}`,
      in_page_widget_lifecycle_control_proposal_expires: `过期：${values?.expiresAt}`,
      in_page_widget_lifecycle_control_proposal_approve: "批准",
      in_page_widget_lifecycle_control_proposal_reject: "拒绝",
    })[key] ?? "");

    expect(translated.regionLabel).toBe("页面引用");
    expect(translated.openLabel(2, "已连接")).toBe("打开，2 个，已连接");
    expect(translated.copySucceeded(3)).toBe("已复制 3 个。");
    expect(translated.invitationCopied).toBe(
      "连接邀请已复制。请粘贴给本地 Agent，由它接受连接。",
    );
    expect(translated.taskNoteLabel("B")).toBe("目标 B 的说明");
    expect(translated.shortcutBelowNote("A")).toBe("将 A 放在下方。");
    expect(translated.annotationResolved).toBe("批注已解决。");
    expect(translated.annotationReopened).toBe("批注已重新打开。");
    expect(translated.annotationLifecycleUnconfirmed).toBe("批注状态未确认。");
    expect(translated.lifecycleControlProposalHeading).toBe("Agent 生命周期提案");
    expect(translated.lifecycleControlProposalFingerprint("abc")).toBe("指纹：abc");
    expect(translated.lifecycleControlProposalTransition("open", "resolved"))
      .toBe("转换：open → resolved");
    expect(translated.lifecycleControlProposalExpires("2026-09-01T04:00:00.000Z"))
      .toBe("过期：2026-09-01T04:00:00.000Z");
    expect(translated.approveLifecycleControlProposal).toBe("批准");
    expect(translated.rejectLifecycleControlProposal).toBe("拒绝");
    expect(translated.save).toBe("Save");
  });
});

function model(overrides: Partial<InPageWidgetViewModel> = {}): InPageWidgetViewModel {
  return {
    mode: "editing",
    bridgeState: "connected",
    disclosureRequired: false,
    clearStatus: { clearState: "idle", operationId: null },
    connectionRequestText: null,
    frameScopeOpen: false,
    frameScopes: [
      {
        id: "scope-top",
        kind: "top",
        detail: "https://example.test/",
        depth: 0,
        current: true,
        selectable: true,
      },
      {
        id: "scope-child",
        kind: "embedded",
        detail: "https://frame.test/",
        depth: 1,
        current: false,
        selectable: true,
      },
    ],
    targets: [
      { itemId: "item-a", label: "A", name: "Pricing card" },
      { itemId: "item-b", label: "B", name: "Primary button" },
    ],
    activeItemId: "item-b",
    taskNote: "Match the primary action.",
    shortcuts: [
      { id: "same-spacing", label: "Same spacing", note: "Keep the same spacing." },
      { id: "same-style", label: "Same style", note: "Use the same visual style." },
    ],
    busyAction: null,
    status: null,
    ...overrides,
  };
}

function privateDebugSummary(): PrivateDebugSummaryV1 {
  return {
    schemaVersion: "0.1.0",
    kind: "ui-attach.private-debug-summary",
    scope: "one_capture",
    consent: "explicit_one_shot",
    replay: {
      status: "collected",
      attemptCount: 1,
      verifiedCount: 1,
      ambiguousCount: 0,
      missingCount: 0,
    },
    device: {
      status: "collected",
      deviceClass: "desktop",
      viewportClass: "large",
      touch: "none",
    },
    executionAuthority: {
      grantedByCapture: false,
      browserControl: false,
      liveDomMutation: false,
    },
  };
}

function lifecycleControlProposal(
  overrides: Partial<InPageWidgetLifecycleControlProposal> = {},
): InPageWidgetLifecycleControlProposal {
  return {
    itemId: "item-a",
    operationId: "11111111-1111-4111-8111-111111111111",
    fingerprint: "a".repeat(64),
    expectedState: "open",
    nextState: "resolved",
    expiresAt: "2026-09-01T04:00:00.000Z",
    ...overrides,
  };
}

function surface(root: ParentNode): HTMLElement {
  const found = root.querySelector<HTMLElement>("[data-meanthis-widget-surface]");
  if (!found) throw new Error("Missing MeanThis widget surface");
  return found;
}

function actionButtons(root: ParentNode, action: string): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(
    `[data-meanthis-action="${action}"]`,
  ));
}

function actionButton(root: ParentNode, action: string): HTMLButtonElement {
  const found = actionButtons(root, action)[0];
  if (!found) throw new Error(`Missing action button: ${action}`);
  return found;
}

function escape(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}
