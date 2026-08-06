// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UIAttachmentDisclosureMode } from "@meanthis/schema";
import type { PanelThemePreference } from "./panel-theme";
import type {
  PreviewCopyPreference,
  RelationShortcutPreference,
  TimeDisplayPreference,
} from "./settings-preferences";
import type { PanelHandoffFormatPreferences } from "./panel-handoff-format";
import type {
  PanelSessionController,
  PanelSessionSnapshot,
} from "./panel-session-controller";
import type { OriginCaptureRecord } from "./capture-store";
import type { FirstCaptureDisclosureStore } from "./first-capture-disclosure";
import { ENGLISH_MESSAGES } from "./i18n";
import type { SessionFileResult, StoredSessionHandoffData } from "./session-file";
import type { StoredOriginSessionSummary } from "./session-store";
import {
  createCaptureRecord,
  createSessionFile,
} from "../test/session-fixtures";
import {
  createBrowserPanelDependencies,
  initializePanel,
  type PanelDependencies,
} from "./panel";

const ORIGIN = "https://app.example.test";
const PANEL_CSS = readFileSync("apps/extension-mv3/src/panel.css", "utf8");
const PANEL_HTML = readFileSync("apps/extension-mv3/panel.html", "utf8");

describe("extension session panel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:34:56.789Z"));
    document.body.innerHTML = createPanelDom();
    document.documentElement.removeAttribute("data-theme");
  });

  test("does not initialize or schedule local bridge work without a bridge dependency", async () => {
    const setInterval = vi.fn(() => 1);

    await initializePanel(createPanelDependencies(createFakeController(), { setInterval }));

    expect(setInterval).not.toHaveBeenCalled();
  });

  test("keeps first-capture trust facts scannable without implying selection auto-starts", () => {
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const points = parsed.querySelectorAll(".first-capture-disclosure-points > li");
    const acknowledgement = parsed.querySelector<HTMLButtonElement>(
      "#acknowledge-first-capture",
    );

    expect(points).toHaveLength(4);
    expect(parsed.querySelector("#first-capture-disclosure-intro")?.textContent).toBe(
      "MeanThis creates references for elements you choose. Each reference may also include page and nearby context.",
    );
    expect(parsed.querySelector('[data-i18n="first_capture_disclosure_redaction"]')?.textContent)
      .not.toMatch(/best-effort|data-loss-prevention/iu);
    expect(parsed.querySelector('[data-i18n="first_capture_disclosure_redaction"]')?.textContent)
      .toMatch(/Agent-safe.*Developer diagnostic.*Full debug/iu);
    expect(parsed.querySelector('[data-i18n="first_capture_disclosure_local"]')?.textContent)
      .toMatch(/copy, export, or connect the optional local agent bridge/iu);
    expect(parsed.querySelector('[data-i18n="first_capture_disclosure_receiver"]')?.textContent)
      .toMatch(/Agent-safe context refreshes automatically over that local connection/iu);
    for (const key of [
      "first_capture_disclosure_heading",
      "first_capture_disclosure_intro",
      "first_capture_disclosure_data",
      "first_capture_disclosure_local",
      "first_capture_disclosure_redaction",
      "first_capture_disclosure_receiver",
      "first_capture_disclosure_first_trial",
    ] as const) {
      expect(parsed.querySelector(`[data-i18n="${key}"]`)?.textContent)
        .toBe(ENGLISH_MESSAGES[key]);
    }
    expect(acknowledgement?.dataset.i18n).toBe("acknowledge_and_return");
    expect(acknowledgement?.textContent).toBe("I understand — return to Add elements");
  });

  test("keeps disclosure open and selection stopped when acknowledgement cannot persist", async () => {
    const savedSelectionStates: boolean[] = [];
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => false),
      acknowledge: vi.fn(async () => {
        throw new Error("storage failed");
      }),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      firstCaptureDisclosure,
      testClickCapture: {
        read: async () => false,
        save: async (enabled) => { savedSelectionStates.push(enabled); },
      },
    }));

    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();

    const disclosure = query<HTMLDialogElement>("#first-capture-disclosure");
    expect(disclosure.open).toBe(true);
    expect(savedSelectionStates).toEqual([]);
    expect(query("#element-selection-toggle").getAttribute("aria-pressed")).toBe("false");

    query<HTMLButtonElement>("#acknowledge-first-capture").click();
    await flushMicrotasks();

    expect(disclosure.open).toBe(true);
    expect(query("#first-capture-disclosure-status").textContent).toBe(
      "Panel action failed. Try again.",
    );
    expect(savedSelectionStates).toEqual([]);
  });

  test("closes a persisted disclosure without auto-starting selection", async () => {
    let acknowledged = false;
    let selectionEnabled = false;
    const savedSelectionStates: boolean[] = [];
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => acknowledged),
      acknowledge: vi.fn(async () => { acknowledged = true; }),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      firstCaptureDisclosure,
      testClickCapture: {
        read: async () => selectionEnabled,
        save: async (enabled) => {
          selectionEnabled = enabled;
          savedSelectionStates.push(enabled);
        },
      },
    }));

    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    toggle.click();
    await flushMicrotasks();
    expect(query<HTMLDialogElement>("#first-capture-disclosure").open).toBe(true);
    expect(savedSelectionStates).toEqual([]);

    query<HTMLButtonElement>("#acknowledge-first-capture").click();
    await flushMicrotasks();
    expect(query<HTMLDialogElement>("#first-capture-disclosure").open).toBe(false);
    expect(savedSelectionStates).toEqual([]);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    toggle.click();
    await flushMicrotasks();
    expect(savedSelectionStates).toEqual([true]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("keeps first capture blocked when the disclosure is dismissed", async () => {
    const savedSelectionStates: boolean[] = [];
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => false),
      acknowledge: vi.fn(async () => undefined),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      firstCaptureDisclosure,
      testClickCapture: {
        read: async () => false,
        save: async (enabled) => { savedSelectionStates.push(enabled); },
      },
    }));

    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    const disclosure = query<HTMLDialogElement>("#first-capture-disclosure");
    toggle.click();
    await flushMicrotasks();
    expect(disclosure.open).toBe(true);

    query<HTMLButtonElement>("#dismiss-first-capture").click();
    await flushMicrotasks();
    expect(disclosure.open).toBe(false);
    expect(firstCaptureDisclosure.acknowledge).not.toHaveBeenCalled();
    expect(savedSelectionStates).toEqual([]);

    toggle.click();
    await flushMicrotasks();
    expect(disclosure.open).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(savedSelectionStates).toEqual([]);
  });

  test("keeps the capture toggle primary regardless of captured element count and follows external Escape cancellation", async () => {
    const record = createCaptureRecord("save", "Save changes", "agent_safe");
    const savedSelectionStates: boolean[] = [];
    let currentSelectionState = false;
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const controller = createFakeController();
    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read: async () => currentSelectionState,
        save: async (enabled) => {
          currentSelectionState = enabled;
          savedSelectionStates.push(enabled);
        },
      },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    const copy = query<HTMLButtonElement>("#copy-summary");
    expect(toggle.textContent).toBe("Add elements");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.classList.contains("primary-action")).toBe(true);
    expect(toggle.classList.contains("utility-action")).toBe(false);
    expect(copy.classList.contains("primary-action")).toBe(true);
    expect(PANEL_HTML).not.toContain("Test click capture");

    expect(toggle.textContent).toBe("Add elements");

    toggle.click();
    await flushMicrotasks();
    expect(savedSelectionStates).toEqual([true]);
    expect(toggle.textContent).toBe("Stop selecting");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.classList.contains("primary-action")).toBe(true);
    expect(copy.classList.contains("primary-action")).toBe(true);
    expect(copy.classList.contains("utility-action")).toBe(false);
    expect(query("#status").textContent).toBe(
      "Selection enabled. Click page elements to add them. Press Escape when done.",
    );

    controller.__setSnapshot({
      status: { kind: "empty", message: "No active capture session." },
    });
    expect(query("#status").textContent).toBe(
      "Selection enabled. Click page elements to add them. Press Escape when done.",
    );

    currentSelectionState = false;
    runtimeListeners[0]({
      type: "ui-attach:element-selection-updated",
      enabled: false,
    });
    await flushMicrotasks();
    expect(toggle.textContent).toBe("Add elements");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(query("#status").textContent).toBe(
      "Selection stopped. Review the captured elements or select Add elements to continue.",
    );
    expect(toggle.classList.contains("primary-action")).toBe(true);
    expect(toggle.classList.contains("utility-action")).toBe(false);
    expect(copy.classList.contains("primary-action")).toBe(true);

    controller.__setSnapshot({
      file: createSessionFile([record]),
      legacyRecord: record,
      selectedItemId: record.attachment.id,
    });
    expect(toggle.classList.contains("primary-action")).toBe(true);
    expect(toggle.classList.contains("utility-action")).toBe(false);
    expect(copy.classList.contains("primary-action")).toBe(true);
    expect(copy.classList.contains("utility-action")).toBe(false);

    toggle.click();
    await flushMicrotasks();
    expect(toggle.classList.contains("primary-action")).toBe(true);
    expect(toggle.classList.contains("utility-action")).toBe(false);
    expect(copy.classList.contains("primary-action")).toBe(true);
    expect(copy.classList.contains("utility-action")).toBe(false);
  });

  test("stops active selection when Escape is pressed inside the side panel", async () => {
    let currentSelectionState = false;
    const savedSelectionStates: boolean[] = [];
    let keydownListener: ((event: KeyboardEvent) => void) | undefined;
    await initializePanel(createPanelDependencies(createFakeController(), {
      testClickCapture: {
        read: async () => currentSelectionState,
        save: async (enabled) => {
          currentSelectionState = enabled;
          savedSelectionStates.push(enabled);
        },
      },
      addWindowKeyDownListener: (listener) => {
        keydownListener = listener;
      },
    }));

    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();
    expect(currentSelectionState).toBe(true);

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.focus();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    keydownListener?.(escape);
    keydownListener?.(escape);
    await flushMicrotasks();

    expect(savedSelectionStates).toEqual([true, false]);
    expect(query("#element-selection-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(escape.defaultPrevented).toBe(true);
  });

  test("renders dynamic selection state in the browser UI language", async () => {
    let enabled = false;
    const messages: Record<string, string> = {
      add_elements: "添加元素",
      stop_selecting: "停止选择",
      selection_enabled: "选择已开启。点击页面元素即可添加，完成后按 Escape。",
      unsupported_page: "不支持此页面。请打开普通 HTTP(S) 页面来捕获 UI。",
    };
    await initializePanel(createPanelDependencies(createFakeController({
      activeSupported: false,
      activePage: null,
      origin: null,
      status: {
        kind: "empty",
        message: "This page is not supported. Open an HTTP(S) page to capture UI.",
      },
    }), {
      i18n: {
        language: "zh-CN",
        t: (key: string) => messages[key] ?? key,
      },
      testClickCapture: {
        read: async () => enabled,
        save: async (next) => {
          enabled = next;
        },
      },
    }));

    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    expect(toggle.textContent).toBe("添加元素");
    expect(query("#status").textContent).toBe(
      "不支持此页面。请打开普通 HTTP(S) 页面来捕获 UI。",
    );
    toggle.click();
    await flushMicrotasks();
    expect(toggle.textContent).toBe("停止选择");
    expect(query("#status").textContent).toBe(
      "选择已开启。点击页面元素即可添加，完成后按 Escape。",
    );
  });

  test("localizes the derived ready status after rendering a selected preview", async () => {
    const record = createCaptureRecord("save", "Save changes", "agent_safe");
    const controller = createFakeController({
      file: createSessionFile([record]),
      legacyRecord: record,
      selectedItemId: record.attachment.id,
      intent: "Describe the visible purpose.",
    });
    await initializePanel(createPanelDependencies(controller, {
      i18n: {
        language: "zh-CN",
        t: (key: string) => key === "capture_ready" ? "捕获已就绪。" : key,
      },
    }));

    expect(query("#status").textContent).toBe("捕获已就绪。");

    controller.__setSnapshot({
      status: { kind: "ready", message: "Selected element preview ready." },
    });

    expect(query("#status").textContent).toBe("捕获已就绪。");
  });

  test("turns a permission denial into a toolbar recovery guide without No origin ambiguity", async () => {
    let saveAllowed = false;
    let accessGranted = false;
    const controller = createFakeController({
      activeSupported: false,
      origin: null,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      status: {
        kind: "empty",
        message: "This page is not supported. Open an HTTP(S) page to capture UI.",
      },
    });
    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read: async () => accessGranted,
        save: async () => {
          if (!saveAllowed) throw new Error("Page access is required before selection.");
        },
      },
    }));

    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();

    expect(query<HTMLElement>("#origin").hidden).toBe(true);
    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(false);
    expect(query("#page-access-recovery-heading").textContent).toBe("Reconnect this page");
    expect(query("#page-access-recovery-reason").textContent).toContain(
      "only lets MeanThis read a page after you select MeanThis from the toolbar",
    );
    expect(
      Array.from(document.querySelectorAll("#page-access-recovery li"), (item) => item.textContent),
    ).toEqual([
      "Keep this page active.",
      "Select MeanThis in the browser toolbar.",
      "Select Add elements again.",
    ]);
    expect(query("#status").textContent).toBe("Page access is required before selection.");

    controller.__setSnapshot({
      status: { kind: "ready", message: "Capture ready." },
    });

    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(false);
    expect(query("#status").textContent).toBe("Page access is required before selection.");

    saveAllowed = true;
    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();
    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(false);
    expect(query("#status").textContent).toBe("Page access is required before selection.");

    accessGranted = true;
    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();
    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(true);
  });

  test("uses a reload-first recovery when the content script becomes unavailable", async () => {
    let contentReachable = false;
    const controller = createFakeController({
      activeSupported: true,
      origin: "https://example.com",
      file: null,
      legacyRecord: null,
      selectedItemId: null,
    });
    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read: async () => contentReachable,
        save: async () => {
          if (!contentReachable) {
            throw new Error(
              "MeanThis cannot reach this page. Reload it, then select Add elements again.",
            );
          }
        },
      },
    }));

    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();

    expect(query("#page-access-recovery-heading").textContent).toBe("Reload and reconnect");
    expect(query("#page-access-recovery-reason").textContent).toContain("lost access");
    expect(query("#page-access-recovery-first-step").textContent).toBe("Reload this page.");

    controller.__setSnapshot({
      status: { kind: "ready", message: "Capture ready." },
    });

    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(false);
    expect(query("#status").textContent).toBe(
      "MeanThis cannot reach this page. Reload it, then select Add elements again.",
    );

    contentReachable = true;
    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();
    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(true);
  });

  test("keeps global settings behind one accessible header action and developer tools off the consumer surface", async () => {
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const advancedSession = parsed.querySelector<HTMLDetailsElement>("#advanced-session-tools");
    const advancedData = parsed.querySelector<HTMLDetailsElement>("#advanced-data");
    const optionalSettings = parsed.querySelector<HTMLDetailsElement>("#optional-settings");
    const handoffOptions = parsed.querySelector<HTMLElement>("#handoff-options");
    const savedSites = parsed.querySelector<HTMLDetailsElement>("#saved-sites");

    const settingsButton = parsed.querySelector<HTMLButtonElement>("#open-settings");
    expect(settingsButton?.getAttribute("aria-label")).toBe("Settings");
    expect(settingsButton?.getAttribute("title")).toBe("Settings");
    expect(settingsButton?.querySelector(".settings-icon")).not.toBeNull();
    expect(parsed.querySelector("#current-content-mode")?.textContent).toBe("Agent-safe");
    expect(parsed.querySelector("#advanced-settings")).toBeNull();
    expect(parsed.querySelector("#capture-mode")).toBeNull();
    expect(parsed.querySelector("#theme-preference")).toBeNull();
    expect(PANEL_CSS).toMatch(/\.settings-button\s*{[^}]*width:\s*36px;[^}]*height:\s*36px;/s);
    expect(advancedSession?.open).toBe(false);
    expect(advancedSession?.hidden).toBe(true);
    expect(advancedSession?.hasAttribute("data-developer-tooling")).toBe(true);
    expect(advancedSession?.querySelector("#export-session")).not.toBeNull();
    expect(parsed.querySelector("#clear-session")?.textContent?.trim()).toBe("Clear selected elements");
    expect(parsed.querySelector("#clear-session")?.classList.contains("session-reset")).toBe(true);
    expect(parsed.querySelector('[data-i18n="session"]')?.textContent?.trim()).toBe(
      "Selected elements",
    );
    expect(advancedData?.open).toBe(false);
    expect(advancedData?.hidden).toBe(true);
    expect(advancedData?.hasAttribute("data-developer-tooling")).toBe(true);
    expect(advancedData?.querySelector("#markdown")).not.toBeNull();
    expect(advancedData?.querySelector("#json")).not.toBeNull();
    expect(optionalSettings?.open).toBe(false);
    expect(optionalSettings?.hidden).toBe(true);
    expect(handoffOptions?.hidden).toBe(true);
    expect(handoffOptions?.querySelector("#handoff-options-heading")).toBeNull();
    expect(handoffOptions?.querySelector("#handoff-format")).not.toBeNull();
    const handoffPreview = handoffOptions?.querySelector<HTMLDetailsElement>("#agent-handoff-preview");
    expect(handoffPreview?.tagName).toBe("DETAILS");
    expect(handoffPreview?.open).toBe(false);
    expect(handoffPreview?.querySelector(":scope > summary")?.textContent?.trim()).toBe(
      "Preview copy content",
    );
    expect(handoffPreview?.querySelector("#agent-handoff-text")).not.toBeNull();
    expect(parsed.querySelector("details#agent-handoff-preview")).toBe(handoffPreview);
    expect(savedSites?.hidden).toBe(true);
    expect(advancedData?.querySelector("summary")?.textContent?.trim()).toBe(
      "Developer diagnostics",
    );
    expect(advancedData?.querySelector('[data-i18n="developer_diagnostics_help"]')).not.toBeNull();
    expect(parsed.querySelector("#copy-summary")?.compareDocumentPosition(advancedData!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const copyFeedback = parsed.querySelector("#agent-handoff-copy-feedback");
    const copyStatus = parsed.querySelector("#agent-handoff-copy-status");
    const copyNextStep = parsed.querySelector("#agent-handoff-copy-next-step");
    expect(copyFeedback?.getAttribute("role")).toBe("status");
    expect(copyFeedback?.getAttribute("aria-live")).toBe("polite");
    expect(copyFeedback?.getAttribute("aria-atomic")).toBe("true");
    expect(copyFeedback?.contains(copyStatus!)).toBe(true);
    expect(copyFeedback?.contains(copyNextStep!)).toBe(true);
    expect(parsed.querySelector("#copy-summary")?.compareDocumentPosition(copyFeedback!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const controller = createFakeController({
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      intent: "",
      status: {
        kind: "empty",
        message: "No session for this origin. Capture an element to start one.",
      },
    });
    await initializePanel(createPanelDependencies(controller));

    const emptyWorkflow = query<HTMLElement>("#empty-workflow");
    expect(emptyWorkflow.hidden).toBe(false);
    expect(query<HTMLElement>("#session").hidden).toBe(true);
    expect(query<HTMLDetailsElement>("#saved-sites").hidden).toBe(true);
    expect(Array.from(emptyWorkflow.querySelectorAll("li"), (step) => (
      step.textContent?.replace(/\s+/g, " ").trim()
    ))).toEqual([
      "Add elements Select Add elements, then click each page target.",
      "Describe the change Write the result you want.",
      "Copy for agent Review the selected labels, then copy the handoff.",
    ]);
    expect(query<HTMLButtonElement>("#element-selection-toggle").disabled).toBe(false);

    const record = createCaptureRecord("save", "Save changes", "agent_safe");
    controller.__setSnapshot({
      file: createSessionFile([record]),
      legacyRecord: record,
      selectedItemId: record.id,
      intent: "Move Save changes below the form.",
      status: { kind: "ready", message: "Capture ready." },
    });

    expect(emptyWorkflow.hidden).toBe(true);
    expect(query<HTMLElement>("#session").hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#saved-sites").hidden).toBe(true);
    expect(PANEL_CSS).toMatch(/\.session-reset\s*{[^}]*background:\s*var\(--color-surface\)/s);
    expect(PANEL_CSS).not.toMatch(/\.session-actions button\s*{[^}]*flex:\s*1/s);
    expect(PANEL_CSS).toMatch(/\.actions button:not\(\.session-reset\)\s*{[^}]*width:\s*100%/s);
  });

  test("separates layout help from copy options", () => {
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const relationSettings = parsed.querySelector<HTMLDetailsElement>("#relation-settings");
    const handoffSettings = parsed.querySelector<HTMLDetailsElement>("#optional-settings");
    const relationComposer = parsed.querySelector<HTMLElement>("#relation-composer");
    const handoffOptions = parsed.querySelector<HTMLElement>("#handoff-options");

    expect(relationSettings?.tagName).toBe("DETAILS");
    expect(relationSettings?.open).toBe(false);
    expect(relationSettings?.hidden).toBe(true);
    expect(relationSettings?.querySelector(":scope > summary")?.textContent?.trim()).toBe(
      "Task note shortcuts (optional)",
    );
    expect(handoffSettings?.tagName).toBe("DETAILS");
    expect(handoffSettings?.open).toBe(false);
    expect(handoffSettings?.hidden).toBe(true);
    expect(handoffSettings?.querySelector(":scope > summary")?.textContent?.trim()).toBe(
      "Copy options",
    );
    expect(relationComposer?.tagName).toBe("DIV");
    expect(relationComposer?.querySelector("#relation-composer-heading")).toBeNull();
    expect(handoffOptions?.tagName).toBe("DIV");
    expect(handoffOptions?.querySelector("#handoff-options-heading")).toBeNull();
    expect(relationSettings?.contains(relationComposer ?? null)).toBe(true);
    expect(relationSettings?.contains(handoffOptions ?? null)).toBe(false);
    expect(handoffSettings?.contains(relationComposer ?? null)).toBe(false);
    expect(handoffSettings?.contains(handoffOptions ?? null)).toBe(true);
    expect(handoffSettings?.querySelector("#agent-handoff-preview-heading")?.textContent?.trim()).toBe(
      "Preview copy content",
    );
  });

  test("shows diagnostic exports only on the development surface", async () => {
    const consumerController = createFakeController();
    await initializePanel(createPanelDependencies(consumerController, {
      surfaceProfile: "consumer",
    }));

    expect(query<HTMLDetailsElement>("#advanced-data").hidden).toBe(true);
    expect(query<HTMLDetailsElement>("#advanced-session-tools").hidden).toBe(true);

    document.body.innerHTML = createPanelDom();
    const developmentController = createFakeController();
    await initializePanel(createPanelDependencies(developmentController, {
      surfaceProfile: "development",
    }));

    expect(query<HTMLDetailsElement>("#advanced-data").hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#advanced-session-tools").hidden).toBe(false);
  });

  test("keeps saved-site history visible while the active origin changes", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 2)];
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const controller = createFakeController();

    await initializePanel(createPanelDependencies(controller, { storedSessions }));

    expect(query<HTMLDetailsElement>("#saved-sites").hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#saved-sites").open).toBe(false);
    expect(query("#saved-sites-count").textContent).toBe("1");
    expect(query("#saved-sites-list").textContent).toContain(ORIGIN);

    controller.__setSnapshot({
      activeSupported: false,
      activePage: null,
      origin: null,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
    });
    expect(query<HTMLDetailsElement>("#saved-sites").hidden).toBe(false);

    const otherOrigin = "https://admin.example.test";
    controller.__setSnapshot({
      activeSupported: true,
      activePage: { tabId: 2, frameId: 0, origin: otherOrigin, pathname: "/billing" },
      origin: otherOrigin,
    });
    expect(query<HTMLDetailsElement>("#saved-sites").hidden).toBe(false);
  });

  test("lists saved origins without live page access and clears one inactive origin", async () => {
    const stored = [
      storedOrigin("https://admin.example.test", "epoch-admin", 1),
      storedOrigin(ORIGIN, "epoch-app", 2),
    ];
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(),
      clear: vi.fn(async (origin: string) => {
        const index = stored.findIndex((entry) => entry.origin === origin);
        if (index >= 0) stored.splice(index, 1);
        return { ok: true as const, data: emptyReadback(origin) };
      }),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const confirmations: string[] = [];
    const controller = createFakeController({
      activeSupported: false,
      activePage: null,
      origin: null,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
    });

    await initializePanel(createPanelDependencies(controller, {
      storedSessions,
      confirm: (message) => {
        confirmations.push(message);
        return true;
      },
    }));

    expect(query<HTMLDetailsElement>("#saved-sites").open).toBe(false);
    expect(query<HTMLDetailsElement>("#saved-sites").hidden).toBe(false);
    expect(query("#saved-sites-count").textContent).toBe("2");
    expect(query("#saved-sites-count").getAttribute("aria-label")).toBe("Saved captures: 2");
    expect(Array.from(document.querySelectorAll(".saved-site-origin"), (row) => row.textContent)).toEqual([
      "https://admin.example.test",
      ORIGIN,
    ]);
    expect(Array.from(document.querySelectorAll(".saved-site-count"), (row) => row.textContent)).toEqual([
      "1 target",
      "2 targets",
    ]);
    expect(query("[data-review-saved-origin]").classList.contains("utility-action")).toBe(true);
    expect(query("[data-clear-saved-origin]").classList.contains("utility-action")).toBe(true);
    expect(query("[data-clear-saved-origin]").classList.contains("destructive-action")).toBe(true);
    expect(query("#clear-all-saved-sites").classList.contains("utility-action")).toBe(true);
    expect(query("#clear-all-saved-sites").classList.contains("destructive-action")).toBe(true);
    expect(PANEL_CSS).toMatch(/\.utility-action\s*{[^}]*background:\s*var\(--color-surface\)/s);
    expect(PANEL_CSS).not.toMatch(/\.restore-action\s*{/s);
    expect(PANEL_CSS).not.toMatch(/\.danger-action\s*{/s);
    expect(query("#saved-sites-list").textContent).not.toContain("/settings");

    query<HTMLButtonElement>("[data-clear-saved-origin=\"https://admin.example.test\"]").click();
    await flushMicrotasks();

    expect(confirmations).toEqual([
      "Clear the saved UI reference session for https://admin.example.test? Captured targets and intents for this site will be removed.",
    ]);
    expect(storedSessions.clear).toHaveBeenCalledWith(
      "https://admin.example.test",
      "epoch-admin",
      "operation-1",
    );
    await vi.waitFor(() => expect(query("#saved-sites-count").textContent).toBe("1"));
    expect(query("#saved-sites-status").textContent).toBe("Saved capture cleared.");
    expect(controller.refreshActiveOrigin).toHaveBeenCalledTimes(1);
  });

  test("reserves the viewport scrollbar gutter so full-width capture controls do not resize", () => {
    expect(PANEL_CSS).toMatch(/:root\s*{[^}]*scrollbar-gutter:\s*stable;/s);
  });

  test("uses the compact Stitch-derived workbench layout without changing panel controls", () => {
    expect(PANEL_CSS).toMatch(/\.shell\s*{[^}]*gap:\s*12px;[^}]*padding:\s*16px;/s);
    expect(PANEL_CSS).toMatch(/\.masthead-copy\s*{[^}]*display:\s*contents;/s);
    expect(PANEL_CSS).toMatch(/\.selection-controls\s*{[^}]*grid-column:\s*1\s*\/\s*-1;/s);
    expect(PANEL_CSS).toMatch(/\.session,\s*\n\.capture\s*{[^}]*gap:\s*10px;/s);
    expect(PANEL_CSS).toMatch(/\.session-heading\s*>\s*div:first-child\s*{[^}]*display:\s*flex;[^}]*align-items:\s*baseline;/s);
    expect(PANEL_CSS).toMatch(/\.session-group-rows\s*{[^}]*gap:\s*0;[^}]*padding:\s*0;/s);
    expect(PANEL_CSS).toMatch(/\.session-select\s*{[^}]*border:\s*0;[^}]*padding:\s*7px 9px;/s);
    expect(PANEL_CSS).toMatch(/\.task-field\s*{[^}]*border:\s*1px solid var\(--color-border\);[^}]*background:\s*var\(--color-surface-subtle\);/s);
    expect(PANEL_CSS).toMatch(/\.task-field\s+textarea\s*{[^}]*min-height:\s*56px;/s);
    expect(PANEL_CSS).toMatch(/\.advanced-content\s*{[^}]*border-top:\s*1px solid var\(--color-border\);/s);
    expect(PANEL_CSS).toMatch(/\.saved-site-row\s*{[^}]*border:\s*1px solid var\(--color-border\);[^}]*background:\s*var\(--color-surface-control\);/s);
  });

  test("opens an Agent-safe saved capture review without silently restoring live page authority", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    const stored = [storedOrigin(ORIGIN, "epoch-1", 2)];
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          routes: [],
          items: [
            {
              label: "A",
              target: "button - Save changes",
              intent: "Keep the review action next to the saved site.",
              capturedAt: "2026-07-11T10:00:00.000Z",
              sourceDisclosureMode: "full_debug" as const,
            },
            {
              label: "B",
              target: "link - Cancel",
              intent: "",
              capturedAt: "2026-07-11T10:01:00.000Z",
              sourceDisclosureMode: "agent_safe" as const,
            },
          ],
        },
      })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const controller = createFakeController({
      activeSupported: false,
      activePage: null,
      origin: null,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
    });

    await initializePanel(createPanelDependencies(controller, {
      storedSessions,
      timeDisplay: { read: async () => "local" },
    }));

    query<HTMLDetailsElement>("#relation-settings").open = true;
    query<HTMLDetailsElement>("#optional-settings").open = true;
    query<HTMLDetailsElement>("#agent-handoff-preview").open = true;
    const reviewButton = query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`);
    reviewButton.focus();
    reviewButton.click();
    await flushMicrotasks();

    expect(storedSessions.review).toHaveBeenCalledWith(ORIGIN);
    expect(query(".saved-review-origin").textContent).toBe(ORIGIN);
    expect(query(".saved-review-state").textContent).toBe("Saved capture · Local");
    expect(query(".saved-review-help").textContent).toBe(
      "Capture-time Agent-safe summary. Find the original tab or a matching frame on the " +
      "current page to recheck its targets.",
    );
    expect(Array.from(document.querySelectorAll(".saved-review-target"), (target) => target.textContent)).toEqual([
      "A · button - Save changes",
      "B · link - Cancel",
    ]);
    expect(query(".saved-review-intent").textContent).toBe(
      "Task note: Keep the review action next to the saved site.",
    );
    expect(document.querySelectorAll(".saved-review-intent")).toHaveLength(1);
    expect(query("#saved-sites-list").textContent).not.toContain("No standalone task");
    expect(document.querySelectorAll(".saved-review-meta-disclosure")).toHaveLength(2);
    expect(query(".saved-review-meta-disclosure > summary").textContent).toBe("Capture details");
    expect(query(".saved-review-meta").textContent).toBe(
      "2026-07-11 18:00 GMT+8 · Source: Full debug",
    );
    expect(query<HTMLDetailsElement>("#relation-settings").open).toBe(false);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(false);
    expect(query<HTMLDetailsElement>("#agent-handoff-preview").open).toBe(false);
    expect(query("#saved-sites-list").textContent).not.toContain("ada@example.com");
    expect(query("#saved-sites-list").textContent).not.toContain("sk-test-stored-secret");
    expect(query("#saved-sites-list").textContent).not.toContain("token=stored-secret");
    expect(queryOptional("#saved-sites-list [data-copy-saved-origin]")).toBeNull();
    expect(controller.refreshActiveOrigin).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(query("[data-close-saved-review]"));
    expect(query("[data-close-saved-review]").classList.contains("utility-action")).toBe(true);

    query<HTMLButtonElement>("[data-close-saved-review]").click();
    expect(queryOptional(".saved-review-origin")).toBeNull();
    const restoredReview = query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`);
    expect(restoredReview.textContent).toBe("Review");
    expect(document.activeElement).toBe(restoredReview);
  });

  test("finds and restores saved routes without requiring a preselected frame scope", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 2)];
    const restoreRoute = vi.fn(async (route: { frameKind: "top" | "embedded" }) => (
      route.frameKind === "embedded"
        ? {
            ok: false as const,
            code: "SAVED_ROUTE_NOT_OPEN",
            error: "Open the page that contains this saved frame and try again.",
          }
        : {
            ok: true as const,
            data: {
              origin: ORIGIN,
              pathname: "/settings",
              items: [
                { itemId: "att_save", status: "restored" as const },
                { itemId: "att_cancel", status: "missing" as const },
              ],
            },
          }
    ));
    const openSavedRoute = vi.fn(async () => undefined);
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    let selectionEnabled = true;
    const testClickCapture = {
      read: vi.fn(async () => selectionEnabled),
      save: vi.fn(async (enabled: boolean) => { selectionEnabled = enabled; }),
    };
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          routes: [
            {
              origin: ORIGIN,
              pathname: "/settings",
              frameKind: "top" as const,
              targetCount: 1,
            },
            {
              origin: ORIGIN,
              pathname: "/embedded",
              frameKind: "embedded" as const,
              targetCount: 1,
            },
            {
              origin: ORIGIN,
              pathname: "/%5Bredacted%3Apathname%5D",
              frameKind: "top" as const,
              targetCount: 1,
            },
          ],
          items: [
            {
              label: "A",
              target: "button - Save changes",
              intent: "",
              capturedAt: "2026-07-11T10:00:00.000Z",
              sourceDisclosureMode: "agent_safe" as const,
            },
            {
              label: "B",
              target: "button - Cancel",
              intent: "",
              capturedAt: "2026-07-11T10:01:00.000Z",
              sourceDisclosureMode: "agent_safe" as const,
            },
          ],
        },
      })),
      restoreRoute,
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const controller = createFakeController({
      activePage: { tabId: 8, frameId: 0, origin: ORIGIN, pathname: "/account" },
    });
    controller.refreshActiveOrigin = vi.fn(async (preferredItemId?: string) => {
      if (preferredItemId) controller.__setSnapshot({ selectedItemId: preferredItemId });
    });
    controller.selectItem = vi.fn(async (itemId: string) => {
      controller.__setSnapshot({ selectedItemId: itemId });
    });

    await initializePanel(createPanelDependencies(controller, {
      storedSessions,
      openSavedRoute,
      testClickCapture,
      localBridge,
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();

    expect(query(".saved-review-routes").textContent).toContain("/settings");
    expect(query(".saved-review-routes").textContent).toContain("Embedded frame");
    expect(query(".saved-review-routes").textContent).not.toContain("redacted");
    expect(document.querySelectorAll("[data-open-saved-route]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-restore-saved-origin]")).toHaveLength(2);
    const embeddedRestore = query<HTMLButtonElement>(
      '[data-restore-saved-pathname="/embedded"]',
    );
    expect(embeddedRestore.textContent).toBe("Find and restore");
    expect(embeddedRestore.classList.contains("utility-action")).toBe(true);
    expect(query("[data-copy-saved-page-route]").classList.contains("utility-action")).toBe(true);
    expect(query("[data-open-saved-route]").classList.contains("utility-action")).toBe(true);
    localBridge.publish.mockClear();

    embeddedRestore.click();
    await flushMicrotasks();
    expect(testClickCapture.save).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(restoreRoute).toHaveBeenCalledWith({
      origin: ORIGIN,
      pathname: "/embedded",
      frameKind: "embedded",
      targetCount: 1,
    }));
    expect(query("#saved-sites-status").textContent).toBe(
      "MeanThis did not find this saved frame in its original tab or the current page. " +
      "Open the page that contains it and try again.",
    );
    await vi.waitFor(() => expect(localBridge.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      activity: {
        operation: "saved_restore",
        state: "failed",
        stage: "background_response",
        code: "SAVED_ROUTE_NOT_OPEN",
      },
    }));
    expect(localBridge.publish.mock.calls.at(-1)?.[0].activity).not.toHaveProperty("route");

    query<HTMLButtonElement>("[data-open-saved-route]").click();
    await flushMicrotasks();
    expect(openSavedRoute).toHaveBeenCalledWith(`${ORIGIN}/settings`);
    expect(query("#saved-sites-status").textContent).toBe(
      "Page opened. If restore is unavailable there, invoke MeanThis once from the toolbar.",
    );

    controller.__setSnapshot({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    });
    await flushMicrotasks();
    expect(document.querySelectorAll("[data-restore-saved-origin]")).toHaveLength(2);
    expect(query("#element-selection-toggle").getAttribute("aria-pressed")).toBe("false");

    query<HTMLButtonElement>('[data-restore-saved-pathname="/settings"]').click();
    await flushMicrotasks();
    expect(testClickCapture.save).toHaveBeenCalledWith(false);
    expect(query("#element-selection-toggle").getAttribute("aria-pressed")).toBe("false");
    await vi.waitFor(() => expect(restoreRoute).toHaveBeenCalledWith({
      origin: ORIGIN,
      pathname: "/settings",
      frameKind: "top",
      targetCount: 1,
    }));
    await vi.waitFor(() => expect(query("#status").textContent).toBe(
      "Restored 1 targets. You can continue editing task notes or copy for agent. " +
      "1 missing · 0 ambiguous.",
    ));
    expect(query("#saved-sites-status").textContent).toBe("");
    expect(query("#status").textContent).toBe(
      "Restored 1 targets. You can continue editing task notes or copy for agent. " +
      "1 missing · 0 ambiguous.",
    );
    expect(query<HTMLDetailsElement>("#saved-sites").open).toBe(false);
    expect(query("#session-count").textContent).toBe("1 on this page · 1 elsewhere · 2 total");
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe("Copy for agent (1)");
    expect(controller.refreshActiveOrigin).toHaveBeenLastCalledWith();
    expect(controller.selectItem).toHaveBeenLastCalledWith("att_save");

  });

  test("keeps an unchanged saved restore control mounted across active-page refreshes", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const refreshedList = createDeferred<{
      ok: true;
      data: ReturnType<typeof storedOrigin>[];
    }>();
    let listCallCount = 0;
    const restoreRoute = vi.fn(async () => ({
      ok: false as const,
      code: "SAVED_ROUTE_NOT_OPEN",
      error: "Open the page that contains this saved frame and try again.",
    }));
    const storedSessions = {
      list: vi.fn(async () => {
        listCallCount += 1;
        return listCallCount === 1
          ? { ok: true as const, data: structuredClone(stored) }
          : refreshedList.promise;
      }),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          routes: [{
            origin: ORIGIN,
            pathname: "/embedded",
            frameKind: "embedded" as const,
            targetCount: 1,
          }],
          items: [{
            label: "A",
            target: "button - Save changes",
            intent: "",
            capturedAt: "2026-07-11T10:00:00.000Z",
            sourceDisclosureMode: "agent_safe" as const,
          }],
        },
      })),
      restoreRoute,
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const controller = createFakeController({
      activePage: { tabId: 8, frameId: 0, origin: ORIGIN, pathname: "/host" },
    });

    await initializePanel(createPanelDependencies(controller, {
      storedSessions,
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    const restore = query<HTMLButtonElement>('[data-restore-saved-pathname="/embedded"]');

    runtimeListeners[0]({
      type: "ui-attach:active-origin-changed",
      accessRequired: false,
      enabled: true,
      origin: ORIGIN,
    });
    await vi.waitFor(() => expect(storedSessions.list).toHaveBeenCalledTimes(2));
    refreshedList.resolve({ ok: true, data: structuredClone(stored) });
    await flushMicrotasks();

    expect(query('[data-restore-saved-pathname="/embedded"]')).toBe(restore);
    restore.click();
    await vi.waitFor(() => expect(restoreRoute).toHaveBeenCalledTimes(1));
  });

  test("shows the top page for an embedded capture and restores it into a ready current-page workspace", async () => {
    const save = createCaptureRecord("save", "Save changes", "agent_safe");
    save.tabId = 7;
    save.frameId = 3;
    save.pageUrl = `${ORIGIN}/embedded`;
    const cancel = createCaptureRecord("cancel", "Cancel", "agent_safe");
    cancel.tabId = 7;
    cancel.frameId = 3;
    cancel.pageUrl = `${ORIGIN}/embedded`;
    const file = createSessionFile([save, cancel]);
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const openSavedRoute = vi.fn(async () => undefined);
    const restoreResponse = createDeferred<{
      ok: true;
      data: {
        origin: string;
        pathname: string;
        items: Array<{ itemId: string; status: "restored" }>;
      };
    }>();
    const restoreRoute = vi.fn(async () => restoreResponse.promise);
    const restoredData = {
      ok: true as const,
      data: {
        origin: ORIGIN,
        pathname: "/embedded",
        items: [
          { itemId: "att_save", status: "restored" as const },
          { itemId: "att_cancel", status: "restored" as const },
        ],
      },
    };
    const storedSessions = {
      list: vi.fn(async () => ({
        ok: true as const,
        data: [storedOrigin(ORIGIN, "epoch-1", 2)],
      })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          routes: [{
            origin: ORIGIN,
            pathname: "/embedded",
            frameKind: "embedded" as const,
            targetCount: 2,
            topPage: { origin: "https://docs.example.test", pathname: "/mcp/reference" },
            frameChain: [
              { origin: "https://docs.example.test", pathname: "/mcp/reference" },
              { origin: ORIGIN, pathname: "/embedded" },
            ],
          }],
          items: [
            {
              label: "A",
              target: "button - Save changes",
              intent: "",
              capturedAt: "2026-07-11T10:00:00.000Z",
              sourceDisclosureMode: "agent_safe" as const,
            },
            {
              label: "B",
              target: "button - Cancel",
              intent: "",
              capturedAt: "2026-07-11T10:01:00.000Z",
              sourceDisclosureMode: "agent_safe" as const,
            },
          ],
        },
      })),
      restoreRoute,
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const controller = createFakeController({
      activePage: { tabId: 9, frameId: 0, origin: ORIGIN, pathname: "/account" },
      file,
      selectedItemId: "att_cancel",
    });
    controller.refreshActiveOrigin = vi.fn(async (preferredItemId?: string) => {
      controller.__setSnapshot({
        activePage: {
          tabId: 19,
          frameId: 6,
          origin: ORIGIN,
          pathname: "/embedded",
          documentId: "document-restored-01234567",
        },
        selectedItemId: preferredItemId ?? "att_save",
      });
    });
    controller.selectItem = vi.fn(async (itemId: string) => {
      controller.__setSnapshot({ selectedItemId: itemId });
    });
    const runtimeListeners: Array<(message: unknown) => void> = [];

    await initializePanel(createPanelDependencies(controller, {
      clipboard,
      storedSessions,
      openSavedRoute,
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));
    query<HTMLDetailsElement>("#saved-sites").open = true;
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();

    expect(query(".saved-review-route-page").textContent).toBe(
      "https://docs.example.test/mcp/reference",
    );
    expect(query(".saved-review-route-scope").textContent).toContain(
      `docs.example.test/mcp/reference › ${new URL(ORIGIN).host}/embedded`,
    );
    query<HTMLButtonElement>("[data-copy-saved-page-route]").click();
    await flushMicrotasks();
    expect(clipboard.writeText).toHaveBeenCalledWith("https://docs.example.test/mcp/reference");

    query<HTMLButtonElement>("[data-restore-saved-route-key]").click();
    await vi.waitFor(() => expect(restoreRoute).toHaveBeenCalledTimes(1));
    runtimeListeners[0]({
      type: "ui-attach:active-origin-changed",
      accessRequired: false,
      enabled: true,
      origin: ORIGIN,
    });
    await flushMicrotasks();
    restoreResponse.resolve(restoredData);
    await vi.waitFor(() => expect(controller.selectItem).toHaveBeenCalledWith("att_cancel"));

    expect(query<HTMLDetailsElement>("#saved-sites").open).toBe(false);
    expect(queryOptional(".saved-review-origin")).toBeNull();
    expect(query("#session-count").textContent).toBe("2 on this page");
    expect(query<HTMLDetailsElement>(".session-group").open).toBe(true);
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe("Copy for agent (2)");
    expect(query<HTMLButtonElement>("#copy-summary").disabled).toBe(false);
    expect(query("#status").textContent).toBe(
      "Restored 2 targets. You can continue editing task notes or copy for agent. " +
      "0 missing · 0 ambiguous.",
    );
    expect(document.activeElement).toBe(query("#status"));
    expect(controller.refreshActiveOrigin).toHaveBeenCalledWith();
    expect(save.tabId).toBe(7);
    expect(save.frameId).toBe(3);
  });

  test("admits only one saved restore while stopping element selection", async () => {
    const stopSelection = createDeferred<void>();
    const restoreRoute = vi.fn(async () => ({
      ok: false as const,
      code: "SAVED_ROUTE_NOT_OPEN" as const,
      error: "Open the page and try again.",
    }));
    const storedSessions = {
      list: vi.fn(async () => ({
        ok: true as const,
        data: [storedOrigin(ORIGIN, "epoch-1", 1)],
      })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          routes: [{
            origin: ORIGIN,
            pathname: "/settings",
            frameKind: "top" as const,
            targetCount: 1,
          }],
          items: [{
            label: "A",
            target: "button - Save changes",
            intent: "",
            capturedAt: "2026-07-11T10:00:00.000Z",
            sourceDisclosureMode: "agent_safe" as const,
          }],
        },
      })),
      restoreRoute,
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const saveSelection = vi.fn(async (enabled: boolean) => {
      if (!enabled) await stopSelection.promise;
    });

    await initializePanel(createPanelDependencies(createFakeController(), {
      storedSessions,
      testClickCapture: {
        read: async () => true,
        save: saveSelection,
      },
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    const restore = query<HTMLButtonElement>("[data-restore-saved-route-key]");

    restore.click();
    restore.click();
    await flushMicrotasks();

    expect(saveSelection).toHaveBeenCalledTimes(1);
    expect(query<HTMLButtonElement>("[data-restore-saved-route-key]").disabled).toBe(true);
    stopSelection.resolve();
    await vi.waitFor(() => expect(restoreRoute).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(
      query<HTMLButtonElement>("[data-restore-saved-route-key]").disabled,
    ).toBe(false));
  });

  test("reenables saved controls when a session update invalidates an in-flight restore", async () => {
    const restoreResponse = createDeferred<{
      ok: false;
      code: "SAVED_ROUTE_NOT_OPEN";
      error: string;
    }>();
    const storedSessions = {
      list: vi.fn(async () => ({
        ok: true as const,
        data: [storedOrigin(ORIGIN, "epoch-1", 1)],
      })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          routes: [{
            origin: ORIGIN,
            pathname: "/settings",
            frameKind: "top" as const,
            targetCount: 1,
          }],
          items: [{
            label: "A",
            target: "button - Save changes",
            intent: "",
            capturedAt: "2026-07-11T10:00:00.000Z",
            sourceDisclosureMode: "agent_safe" as const,
          }],
        },
      })),
      restoreRoute: vi.fn(async () => restoreResponse.promise),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const runtimeListeners: Array<(message: unknown) => void> = [];

    await initializePanel(createPanelDependencies(createFakeController(), {
      storedSessions,
      testClickCapture: { read: async () => false, save: async () => undefined },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-restore-saved-route-key]").click();
    await vi.waitFor(() => expect(storedSessions.restoreRoute).toHaveBeenCalledTimes(1));

    runtimeListeners[0]({
      type: "ui-attach:session-updated",
      origin: ORIGIN,
      itemId: "att_save",
    });
    await vi.waitFor(() => expect(storedSessions.list).toHaveBeenCalledTimes(2));
    const review = query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`);
    expect(review.disabled).toBe(true);

    restoreResponse.resolve({
      ok: false,
      code: "SAVED_ROUTE_NOT_OPEN",
      error: "Open the page and try again.",
    });
    await vi.waitFor(() => expect(
      query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).disabled,
    ).toBe(false));
  });

  test("copies a reviewed saved snapshot in one action without exposing integration data to consumers", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const markdown = [
      "# MeanThis Saved Snapshot Bundle",
      "ui-attach.saved-snapshot-authority",
      "status: not_rechecked",
      "page.getByRole(\"button\", { name: \"Save changes\" })",
      "Task note: Keep the review action next to the saved site.",
    ].join("\n");
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const localBridge = {
      readStatus: vi.fn(async () => disconnectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(),
      refreshConnectionAndPublish: vi.fn(),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(),
    };
    const bundle = {
      kind: "ui-attach.saved-snapshot-prompt-bundle" as const,
      sessionId: "session-1",
      title: "Settings",
      disclosureMode: "agent_safe" as const,
      attachmentCount: 1,
      attachmentIds: ["att_save"],
      attachmentRefs: [{
        id: "att_save",
        label: "A",
        target: "button Save changes",
        role: "button",
        accessibleName: "Save changes",
        text: "Save changes",
        primaryLocator: 'page.getByRole("button", { name: "Save changes" })',
      }],
      authority: {
        schemaVersion: "0.1.0" as const,
        kind: "ui-attach.saved-snapshot-authority" as const,
        status: "not_rechecked" as const,
        origin: ORIGIN,
        routingPolicy: "omitted" as const,
        evidencePolicy: "capture_time_observations_only" as const,
        controlPolicy: "live_recheck_and_user_confirmation_required" as const,
      },
      markdown,
    };
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          items: [{
            label: "A",
            target: "button - Save changes",
            intent: "Keep the review action next to the saved site.",
            capturedAt: "2026-07-11T10:00:00.000Z",
            sourceDisclosureMode: "full_debug" as const,
          }],
        },
      })),
      prepareHandoff: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          format: "exact" as const,
          bundle,
        },
      })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    const controller = createFakeController({
      activeSupported: false,
      activePage: null,
      origin: null,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
    });

    await initializePanel(createPanelDependencies(controller, {
      clipboard,
      localBridge,
      storedSessions,
      surfaceProfile: "consumer",
    }));

    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    expect(queryOptional(".saved-handoff-preview")).toBeNull();
    expect(queryOptional("[data-prepare-saved-handoff]")).toBeNull();
    expect(query<HTMLButtonElement>("[data-copy-saved-handoff]").textContent).toBe(
      "Copy this snapshot for agent",
    );
    expect(query<HTMLButtonElement>("[data-copy-saved-handoff]").classList)
      .toContain("primary-action");
    expect(query(".saved-handoff-authority").textContent).toContain(
      "Capture-time record · not rechecked",
    );
    expect(queryOptional(".saved-handoff-machine")).toBeNull();
    localBridge.publish.mockClear();

    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();

    expect(storedSessions.prepareHandoff).toHaveBeenCalledTimes(1);
    expect(storedSessions.prepareHandoff).toHaveBeenCalledWith(ORIGIN, "epoch-1");
    expect(clipboard.writeText).toHaveBeenCalledWith(markdown);
    const previewDisclosure = query<HTMLDetailsElement>(".saved-handoff-preview-disclosure");
    expect(previewDisclosure.open).toBe(false);
    expect(previewDisclosure.querySelector("summary")?.textContent).toBe("View what will be copied");
    expect(query<HTMLTextAreaElement>(".saved-handoff-preview").value).toBe(markdown);
    expect(query<HTMLTextAreaElement>(".saved-handoff-preview").readOnly).toBe(true);
    expect(queryOptional(".saved-handoff-machine")).toBeNull();
    expect(query("#saved-sites-status").textContent).toBe("Snapshot copied for agent.");
    expect(query("#saved-sites-status").parentElement?.classList).toContain("saved-handoff");
    expect(query<HTMLButtonElement>("[data-copy-saved-handoff]").nextElementSibling).toBe(
      query("#saved-sites-status"),
    );
    expect(controller.refreshActiveOrigin).not.toHaveBeenCalled();
    expect(localBridge.publish).not.toHaveBeenCalled();
  });

  test("keeps saved bundle JSON inside development integration options", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const handoff = storedHandoffData("development integration bundle");
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({ ok: true as const, data: storedReviewData() })),
      prepareHandoff: vi.fn(async () => ({ ok: true as const, data: handoff })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      clipboard,
      storedSessions,
      surfaceProfile: "development",
    }));

    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();

    const integrationOptions = query<HTMLDetailsElement>(".saved-handoff-machine");
    expect(integrationOptions.open).toBe(false);
    expect(integrationOptions.querySelector("summary")?.textContent).toBe(
      "Developer and integration options",
    );
    integrationOptions.querySelector<HTMLElement>("summary")?.click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-bundle-json]").click();
    await flushMicrotasks();

    expect(storedSessions.prepareHandoff).toHaveBeenCalledTimes(2);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(
      JSON.stringify(handoff.bundle, null, 2),
    );
  });

  test("drops a delayed saved handoff when the saved epoch changes", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const delayed = createDeferred<{
      ok: true;
      data: StoredSessionHandoffData;
    }>();
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: {
          origin: ORIGIN,
          epoch: "epoch-1",
          items: [{
            label: "A",
            target: "button - Save changes",
            intent: "Keep it primary.",
            capturedAt: "2026-07-11T10:00:00.000Z",
            sourceDisclosureMode: "agent_safe" as const,
          }],
        },
      })),
      prepareHandoff: vi.fn(() => delayed.promise),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      storedSessions,
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();

    runtimeListeners[0]({ type: "ui-attach:session-updated", origin: ORIGIN, itemId: "att_new" });
    await flushMicrotasks();
    delayed.resolve({
      ok: true,
      data: storedHandoffData("stale handoff"),
    });
    await flushMicrotasks();

    expect(queryOptional(".saved-handoff-preview")).toBeNull();
    expect(queryOptional("[data-copy-saved-handoff]")).toBeNull();
  });

  test("rejects an undeclared saved-handoff response field before rendering or copying", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({
        ok: true as const,
        data: storedReviewData(),
      })),
      prepareHandoff: vi.fn(async () => ({
        ok: true as const,
        data: { ...storedHandoffData("unsafe response"), tabId: 7 },
      })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      clipboard,
      storedSessions,
    }));

    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();

    expect(queryOptional(".saved-handoff-preview")).toBeNull();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(query("#saved-sites-status").textContent).toBe(
      "Saved snapshot handoff is stale or unavailable. Review the saved capture again.",
    );
  });

  test("keeps the reviewed saved preview local when clipboard copy fails", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const clipboard = { writeText: vi.fn(async () => {
      throw new Error("clipboard unavailable");
    }) };
    const handoff = storedHandoffData("saved preview remains available");
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({ ok: true as const, data: storedReviewData() })),
      prepareHandoff: vi.fn(async () => ({ ok: true as const, data: handoff })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      clipboard,
      storedSessions,
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();

    expect(storedSessions.prepareHandoff).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith(handoff.bundle.markdown);
    expect(query<HTMLTextAreaElement>(".saved-handoff-preview").value).toBe(
      handoff.bundle.markdown,
    );
    expect(query("#saved-sites-status").textContent).toBe(
      "Could not copy the saved snapshot. The preview remains available.",
    );
  });

  test("serializes repeated saved snapshot clipboard writes", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const delayedClipboard = createDeferred<void>();
    const clipboard = {
      writeText: vi.fn()
        .mockImplementationOnce(() => delayedClipboard.promise)
        .mockImplementation(async () => undefined),
    };
    const handoff = storedHandoffData("serialized clipboard handoff");
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({ ok: true as const, data: storedReviewData() })),
      prepareHandoff: vi.fn(async () => ({ ok: true as const, data: handoff })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      clipboard,
      storedSessions,
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(query<HTMLButtonElement>("[data-copy-saved-handoff]").disabled).toBe(true);

    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();
    expect(storedSessions.prepareHandoff).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);

    delayedClipboard.resolve();
    await flushMicrotasks();
    expect(query<HTMLButtonElement>("[data-copy-saved-handoff]").disabled).toBe(false);
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await flushMicrotasks();

    expect(storedSessions.prepareHandoff).toHaveBeenCalledTimes(2);
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(handoff.bundle.markdown);
  });

  test("does not overwrite a saved-data change warning after a delayed clipboard write settles", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const delayedClipboard = createDeferred<void>();
    const clipboard = { writeText: vi.fn(() => delayedClipboard.promise) };
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(async () => ({ ok: true as const, data: storedReviewData() })),
      prepareHandoff: vi.fn(async () => ({
        ok: true as const,
        data: storedHandoffData("copy-time snapshot"),
      })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      clipboard,
      storedSessions,
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));
    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    query<HTMLButtonElement>("[data-copy-saved-handoff]").click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1));

    runtimeListeners[0]({ type: "ui-attach:session-updated", origin: ORIGIN, itemId: "att_new" });
    await flushMicrotasks();
    delayedClipboard.resolve();
    await flushMicrotasks();

    expect(queryOptional(".saved-handoff-preview")).toBeNull();
    expect(query("#saved-sites-status").textContent).toBe(
      "Saved data changed. Review it again to see the latest snapshot.",
    );
  });

  test("does not reopen a stale saved snapshot after the inventory refreshes", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-1", 1)];
    const runtimeListeners: Array<(message: unknown) => void> = [];
    let resolveReview!: (value: {
      ok: true;
      data: {
        origin: string;
        epoch: string;
        items: Array<{
          label: string;
          target: string;
          intent: string;
          capturedAt: string;
          sourceDisclosureMode: "agent_safe";
        }>;
      };
    }) => void;
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(() => new Promise((resolve) => {
        resolveReview = resolve;
      })),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), {
      storedSessions,
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    query<HTMLButtonElement>(`[data-review-saved-origin="${ORIGIN}"]`).click();
    await flushMicrotasks();
    runtimeListeners[0]({
      type: "ui-attach:session-updated",
      origin: ORIGIN,
      itemId: "att_new",
    });
    await flushMicrotasks();
    resolveReview({
      ok: true,
      data: {
        origin: ORIGIN,
        epoch: "epoch-1",
        items: [{
          label: "A",
          target: "button - Old target",
          intent: "Old task",
          capturedAt: "2026-07-11T10:00:00.000Z",
          sourceDisclosureMode: "agent_safe",
        }],
      },
    });
    await flushMicrotasks();

    expect(queryOptional(".saved-review-origin")).toBeNull();
    expect(query("#saved-sites-status").textContent).toBe(
      "Saved capture is unavailable. Refresh Saved captures and try again.",
    );
  });

  test("keeps legacy and invalid saved data cleanup-only", async () => {
    const stored: StoredOriginSessionSummary[] = [
      {
        ...storedOrigin("https://legacy.example.test", null, 1),
        state: "legacy",
      },
      storedOrigin("https://invalid.example.test", null, null),
    ];
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(),
      clear: vi.fn(),
      clearAll: vi.fn(async () => ({ ok: true as const, data: { clearedOrigins: [] } })),
    };

    await initializePanel(createPanelDependencies(createFakeController(), { storedSessions }));

    expect(document.querySelectorAll("[data-review-saved-origin]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-clear-saved-origin]")).toHaveLength(2);
    expect(storedSessions.review).not.toHaveBeenCalled();
  });

  test("keeps a valid empty origin discoverable and clears all saved captures without preferences claims", async () => {
    const stored = [storedOrigin(ORIGIN, "epoch-empty", 0)];
    const storedSessions = {
      list: vi.fn(async () => ({ ok: true as const, data: structuredClone(stored) })),
      review: vi.fn(),
      clear: vi.fn(),
      clearAll: vi.fn(async () => {
        stored.splice(0);
        return { ok: true as const, data: { clearedOrigins: [ORIGIN] } };
      }),
    };
    const confirmations: string[] = [];
    const controller = createFakeController({
      file: createSessionFile([]),
      legacyRecord: null,
      selectedItemId: null,
    });

    await initializePanel(createPanelDependencies(controller, {
      storedSessions,
      confirm: (message) => {
        confirmations.push(message);
        return true;
      },
    }));

    expect(query(".saved-site-count").textContent).toBe("0 targets");
    expect(query<HTMLButtonElement>("#clear-all-saved-sites").disabled).toBe(false);
    expect(query("#clear-all-saved-sites").classList.contains("utility-action")).toBe(true);
    expect(query("#clear-all-saved-sites").classList.contains("destructive-action")).toBe(true);
    query<HTMLButtonElement>("#clear-all-saved-sites").click();
    await flushMicrotasks();

    expect(confirmations).toEqual([
      "Clear every saved UI reference session? Captured targets and intents for all sites will be removed. Extension preferences, exported files, and clipboard contents are not cleared.",
    ]);
    expect(storedSessions.clearAll).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(query("#saved-sites-count").textContent).toBe("0"));
    expect(query("#saved-sites-count").getAttribute("aria-label")).toBe("Saved captures: 0");
    expect(query("#saved-sites-list").textContent).toBe("No saved captures.");
    expect(query("#saved-sites-status").textContent).toBe("All saved captures cleared.");
    expect(controller.refreshActiveOrigin).toHaveBeenCalledTimes(1);
  });

  test("fails saved-site inventory closed without exposing storage errors", async () => {
    const controller = createFakeController();
    await initializePanel(createPanelDependencies(controller, {
      storedSessions: {
        list: vi.fn(async () => ({
          ok: false as const,
          code: "STORAGE_ERROR",
          error: "secret storage path",
        })),
        review: vi.fn(),
        clear: vi.fn(),
        clearAll: vi.fn(),
      },
    }));

    expect(query("#saved-sites-count").textContent).toBe("?");
    expect(query("#saved-sites-count").getAttribute("aria-label")).toBe("Saved captures: ?");
    expect(query("#saved-sites-list").textContent).toBe("Saved captures are unavailable. Try again.");
    expect(document.body.textContent).not.toContain("secret storage path");
    expect(query<HTMLButtonElement>("#clear-all-saved-sites").disabled).toBe(true);
  });

  test("keeps the post-capture task and handoff ahead of diagnostic detail", () => {
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const capture = parsed.querySelector("#capture");
    const session = parsed.querySelector("#session");
    const sessionList = parsed.querySelector("#session-list");
    const intent = parsed.querySelector("#intent");
    const selectedTargetSummary = parsed.querySelector("#selected-target-summary");
    const selectedTargetDetails = parsed.querySelector<HTMLDetailsElement>(
      "#selected-target-details",
    );
    const relationSettings = parsed.querySelector<HTMLDetailsElement>("#relation-settings");
    const optionalSettings = parsed.querySelector<HTMLDetailsElement>("#optional-settings");
    const relationComposer = parsed.querySelector<HTMLElement>("#relation-composer");
    const handoffOptions = parsed.querySelector<HTMLElement>("#handoff-options");
    const copySummary = parsed.querySelector("#copy-summary");
    const advancedData = parsed.querySelector<HTMLDetailsElement>("#advanced-data");

    expect(intent).not.toBeNull();
    expect(sessionList?.parentElement?.classList.contains("session-list-frame")).toBe(true);
    expect(selectedTargetSummary).not.toBeNull();
    expect(selectedTargetDetails?.tagName).toBe("DETAILS");
    expect(selectedTargetDetails?.open).toBe(false);
    expect(parsed.querySelector("#selected-target")).toBeNull();
    expect(relationComposer).not.toBeNull();
    expect(handoffOptions).not.toBeNull();
    expect(copySummary).not.toBeNull();
    expect(advancedData).not.toBeNull();
    expect(parsed.querySelector('[data-i18n="task"]')?.textContent?.trim()).toBe(
      "Task note for selected element",
    );
    expect(relationSettings?.tagName).toBe("DETAILS");
    expect(relationSettings?.open).toBe(false);
    expect(optionalSettings?.tagName).toBe("DETAILS");
    expect(optionalSettings?.open).toBe(false);
    expect(relationComposer?.tagName).toBe("DIV");
    expect(relationComposer?.querySelector("#relation-composer-heading")).toBeNull();
    expect(session?.compareDocumentPosition(capture!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(selectedTargetSummary!.compareDocumentPosition(intent!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(selectedTargetSummary!.compareDocumentPosition(selectedTargetDetails!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(selectedTargetDetails!.compareDocumentPosition(intent!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(intent!.compareDocumentPosition(relationSettings!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(relationSettings!.compareDocumentPosition(copySummary!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(copySummary!.compareDocumentPosition(optionalSettings!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(relationSettings?.contains(relationComposer!)).toBe(true);
    expect(optionalSettings?.contains(relationComposer!)).toBe(false);
    expect(optionalSettings?.contains(handoffOptions!)).toBe(true);
    expect(optionalSettings!.compareDocumentPosition(advancedData!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(relationComposer?.querySelectorAll("select")).toHaveLength(2);
    expect(relationComposer?.querySelector("#apply-relation")).not.toBeNull();
    expect(relationComposer?.querySelector("#swap-relation-targets")).toBeNull();
    expect(relationComposer?.querySelector("[data-relation-action]")).toBeNull();
    expect(advancedData?.querySelector(".summary")).not.toBeNull();
    expect(advancedData?.querySelector("#agent-summary")).not.toBeNull();
    expect(PANEL_CSS).toMatch(/\.session-list\s*{[^}]*max-height:[^;}]+;[^}]*overflow-y:\s*auto/s);
    expect(PANEL_CSS).toMatch(/\.session-list\s*{[^}]*overflow-x:\s*hidden/s);
    expect(PANEL_CSS).toMatch(/\.session-list-frame\s*{[^}]*border:\s*1px solid var\(--color-border-emphasis\)[^}]*overflow:\s*hidden/s);
    expect(PANEL_CSS).toMatch(/\.session-group\s*{[^}]*border:\s*0/s);
    expect(PANEL_CSS).toMatch(/\.session-select:not\(:disabled\):hover\s*{[^}]*border-color:\s*var\(--color-control-hover-border\)[^}]*background:\s*var\(--color-control-hover-bg\)[^}]*box-shadow:\s*inset 3px 0 0 var\(--color-control-hover-accent\)/s);
    expect(PANEL_CSS).toMatch(/\.session-select\[aria-pressed="true"\]\s*{[^}]*background:\s*var\(--color-session-selected-bg\)[^}]*box-shadow:\s*inset 4px 0 0 var\(--color-focus\)/s);
    expect(PANEL_CSS).toMatch(/\.session-select\[aria-pressed="true"\]:not\(:disabled\):hover\s*{[^}]*background:\s*var\(--color-session-selected-hover-bg\)/s);
    expect(PANEL_CSS).toMatch(/\.session-label\s*{[^}]*-webkit-line-clamp:\s*2/s);
    expect(PANEL_CSS).toMatch(/\.selected-target-summary\s*{[^}]*overflow-wrap:\s*anywhere/s);
    expect(PANEL_CSS).toMatch(/\.selected-target-details\s*>\s*summary:focus-visible\s*{[^}]*outline:\s*2px\s+solid\s+var\(--color-focus\)/s);
    expect(PANEL_CSS).not.toMatch(/\.primary-actions\s*{[^}]*position:\s*sticky/s);
    expect(PANEL_CSS).toMatch(/\.advanced-disclosure\s*>\s*summary:focus-visible\s*{[^}]*outline:\s*2px\s+solid\s+var\(--color-focus\)/s);
    expect(PANEL_CSS).toMatch(/\.relation-controls\s*{[^}]*display:\s*grid/s);
  });

  test("defines a collapsed four-step local bridge flow in both product profiles", () => {
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const bridgeSurface = parsed.querySelector<HTMLDetailsElement>("#local-bridge-settings");
    expect(bridgeSurface?.classList.contains("local-bridge")).toBe(true);
    expect(bridgeSurface?.hidden).toBe(false);
    expect(bridgeSurface?.open).toBe(false);
    expect(
      Array.from(
        parsed.querySelectorAll("[data-bridge-step]"),
        (step) => step.getAttribute("data-bridge-step"),
      ),
    ).toEqual(["trust", "request", "approve", "connected"]);
    const details = parsed.querySelector<HTMLDetailsElement>("#local-bridge-details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("#local-bridge-request-text")).not.toBeNull();
    expect(details?.querySelector("#local-bridge-instance")).not.toBeNull();
    expect(PANEL_CSS).toMatch(
      /#local-bridge-trust-field\[hidden\]\s*{[^}]*display:\s*none/s,
    );
    expect(PANEL_CSS).toMatch(
      /\.local-bridge\[hidden\]\s*{[^}]*display:\s*none/s,
    );
  });

  test("keeps status, focus, motion, contrast, and narrow layouts accessible", () => {
    const parsed = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const status = parsed.querySelector("#status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");

    expect(PANEL_CSS).toContain("button:focus-visible");
    expect(PANEL_CSS).toContain("input:focus-visible");
    expect(PANEL_CSS).toContain("select:focus-visible");
    expect(PANEL_CSS).toContain("textarea:focus-visible");
    expect(PANEL_CSS).toContain("summary:focus-visible");
    const primaryFocusOutline =
      /button:focus-visible,\s*input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible,\s*summary:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-focus\)/;
    const advancedFocusOutline =
      /\.advanced-disclosure\s*>\s*summary:focus-visible\s*{[^}]*outline:\s*2px solid var\(--color-focus\)/;
    expect(PANEL_CSS).toMatch(primaryFocusOutline);
    expect(PANEL_CSS).toMatch(advancedFocusOutline);
    expect(PANEL_CSS.replace(
      "outline: 2px solid var(--color-focus);",
      "outline: 1px solid var(--color-focus);",
    )).not.toMatch(primaryFocusOutline);
    expect(PANEL_CSS.replace(
      /\.advanced-disclosure\s*>\s*summary:focus-visible\s*{[^}]*}/,
      (block) => block.replace("outline: 2px", "outline: 1px"),
    )).not.toMatch(advancedFocusOutline);
    expect(PANEL_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(PANEL_CSS).toContain("@media (max-width: 360px)");
    expect(PANEL_CSS).toContain("min-width: 280px");

    for (const [foreground, background] of [
      ["#18202f", "#f7f8fa"],
      ["#5c667a", "#ffffff"],
      ["#ffffff", "#2a69d3"],
      ["#ffffff", "#9a4d00"],
    ]) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("supports system color preference and explicit high-contrast theme overrides", () => {
    expect(PANEL_CSS).toContain(':root[data-theme="dark"]');
    expect(PANEL_CSS).toContain("@media (prefers-color-scheme: dark)");
    expect(PANEL_CSS).toContain(':root:not([data-theme="light"])');
    expect(PANEL_CSS).toContain("background: var(--color-canvas)");
    expect(PANEL_CSS).toContain("color: var(--color-text)");
    expect(PANEL_CSS).toMatch(/\.primary-action\s*{[^}]*color: var\(--color-inverse\)/s);
    expect(PANEL_CSS).toMatch(
      /\.primary-action:hover\s*{[^}]*background: var\(--color-primary-hover\)/s,
    );
    expect(PANEL_CSS).toMatch(/\.primary-action\s*{[^}]*color: var\(--color-inverse\)/s);

    for (const [foreground, background] of [
      ["#f3f5f8", "#10141c"],
      ["#aeb8c8", "#181e29"],
      ["#ffffff", "#2a69d3"],
      ["#ffffff", "#2059b6"],
    ]) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("uses shared interaction states across neutral panel controls in both themes", () => {
    expect(PANEL_CSS).toMatch(/:root\s*{[^}]*--color-control-hover-bg:\s*#e9eef6;[^}]*--color-control-hover-border:\s*#8090a8;/s);
    expect(PANEL_CSS).toMatch(/:root\[data-theme="dark"\]\s*{[^}]*--color-control-hover-bg:\s*#252d3a;[^}]*--color-control-hover-border:\s*#6a7890;/s);
    expect(PANEL_CSS).toMatch(/button:focus-visible,\s*input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible,\s*summary:focus-visible/s);
    expect(PANEL_CSS).toMatch(/select:not\(:disabled\):hover,\s*textarea:not\(\[readonly\]\):not\(:disabled\):hover,\s*\.local-bridge input:not\(:disabled\):hover\s*{[^}]*border-color:\s*var\(--color-control-hover-border\);[^}]*background:\s*var\(--color-control-hover-bg\);/s);
    expect(PANEL_CSS).toMatch(/summary:hover\s*{[^}]*color:\s*var\(--color-text-strong\);[^}]*background:\s*var\(--color-control-hover-bg\);/s);
    expect(PANEL_CSS).toMatch(/\.switch-setting:hover\s+input:not\(:checked\):not\(:disabled\)\s*\+\s*\.switch-track\s*{[^}]*border-color:\s*var\(--color-control-hover-border\);[^}]*background:\s*var\(--color-control-hover-bg\);/s);
    expect(PANEL_CSS).toMatch(/select:disabled,\s*textarea:disabled,\s*\.local-bridge input:disabled\s*{[^}]*cursor:\s*not-allowed;[^}]*opacity:\s*0\.72;/s);

    for (const [foreground, background] of [
      ["#18202f", "#e9eef6"],
      ["#f3f5f8", "#252d3a"],
    ]) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
    for (const [foreground, background] of [
      ["#8090a8", "#ffffff"],
      ["#6a7890", "#181e29"],
    ]) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
    }
  });

  test("does not let a stale selection save overwrite a newer background revocation", async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const read = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const controller = createFakeController();
    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read,
        save: async () => savePending,
      },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    toggle.click();
    await flushMicrotasks();
    runtimeListeners[0]({
      type: "ui-attach:element-selection-updated",
      enabled: false,
    });
    await flushMicrotasks();
    resolveSave();
    await flushMicrotasks();

    expect(read).toHaveBeenCalledTimes(3);
    expect(toggle.textContent).toBe("Add elements");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(query("#status").textContent).toBe(
      "Selection stopped. Review the captured elements or select Add elements to continue.",
    );
  });

  test("keeps the authoritative revocation message when its confirmation read fails", async () => {
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const read = vi.fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("worker stopped"));
    await initializePanel(createPanelDependencies(createFakeController(), {
      testClickCapture: {
        read,
        save: async () => undefined,
      },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    runtimeListeners[0]({
      type: "ui-attach:element-selection-updated",
      enabled: false,
    });
    await flushMicrotasks();

    expect(query("#element-selection-toggle").textContent).toBe("Add elements");
    expect(query("#status").textContent).toBe(
      "Selection stopped. Review the captured elements or select Add elements to continue.",
    );
  });

  test("gives empty selection cancellation and known start failures one next action", async () => {
    let currentSelectionState = true;
    const controller = createFakeController({
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      intent: "",
    });
    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read: async () => currentSelectionState,
        save: async (enabled) => { currentSelectionState = enabled; },
      },
    }));

    query<HTMLButtonElement>("#element-selection-toggle").click();
    await flushMicrotasks();
    expect(query("#status").textContent).toBe(
      "Selection stopped. Select Add elements when you are ready to continue.",
    );

    document.body.innerHTML = createPanelDom();
    const actionable = "MeanThis cannot reach this page. Reload it, then select Add elements again.";
    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read: async () => false,
        save: async () => { throw new Error(actionable); },
      },
    }));
    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    toggle.click();
    await flushMicrotasks();
    expect(query("#status").textContent).toBe(actionable);
    expect(toggle.disabled).toBe(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-theme");
  });

  test("shows the current mode and live-syncs settings changed outside the panel", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    const controller = createFakeController();
    let captureMode: UIAttachmentDisclosureMode = "full_debug";
    let previewCopy = { independent: false, mode: "agent_safe" as const };
    let themePreference: PanelThemePreference = "dark";
    let timeDisplay: TimeDisplayPreference = "utc";
    let relationShortcuts: RelationShortcutPreference[] = [];
    let notifySettingsChanged: (() => void) | undefined;
    const deps = createPanelDependencies(controller, {
      captureMode: {
        read: async () => captureMode,
      },
      previewCopy: { read: async () => previewCopy },
      themePreference: { read: async () => themePreference },
      timeDisplay: { read: async () => timeDisplay },
      relationShortcuts: { read: async () => relationShortcuts },
      addSettingsChangeListener: (listener) => { notifySettingsChanged = listener; },
    });

    await initializePanel(deps);

    expect(query("#current-content-mode").textContent).toBe("Full debug");
    expect(controller.setViewMode).toHaveBeenLastCalledWith("full_debug");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(query("#session-count").textContent).toBe("2 on this page");
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe("Copy for agent (2)");
    expect(query("#selected-target-source").textContent).toBe("Full debug");
    expect(query("[data-item-id=\"att_cancel\"]").getAttribute("aria-pressed")).toBe("true");
    expect(queryOptional("[data-remove-item-id]")).toBeNull();
    expect(query<HTMLButtonElement>("#remove-selected-item").getAttribute("aria-label")).toBe(
      "Remove B: button - Cancel",
    );
    expect(query<HTMLTextAreaElement>("#intent").value).toBe("Update Cancel");
    expect(query<HTMLDetailsElement>("#relation-composer").hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(false);
    expect(query<HTMLSelectElement>("#relation-action").disabled).toBe(true);
    expect(query("#captured-at").textContent).toBe("2026-07-11 10:02 UTC");
    expect(query("#selected-target-captured-at").textContent).toBe("2026-07-11 10:02 UTC");
    expect(query<HTMLSelectElement>("#relation-reference").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#apply-relation").disabled).toBe(true);
    query<HTMLButtonElement>("#apply-relation").click();
    expect(controller.setIntent).not.toHaveBeenCalled();
    expect(query<HTMLTextAreaElement>("#intent").value).toBe("Update Cancel");

    query<HTMLButtonElement>("[data-item-id=\"att_save\"]").click();
    expect(controller.selectItem).toHaveBeenCalledWith("att_save");

    captureMode = "developer_diagnostic";
    previewCopy = { independent: true, mode: "agent_safe" };
    themePreference = "light";
    timeDisplay = "local";
    relationShortcuts = [{
      id: "same-spacing",
      label: "Keep spacing",
      template: "Keep {selected} the same distance from {reference}.",
    }];
    notifySettingsChanged?.();
    await flushMicrotasks();
    expect(controller.setViewMode).toHaveBeenLastCalledWith("agent_safe");
    expect(query("#current-content-mode").textContent).toBe(
      "Capture: Developer diagnostic · Copy: Agent-safe",
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(query("#captured-at").textContent).toBe("2026-07-11 18:02 GMT+8");
    expect(query("#selected-target-captured-at").textContent).toBe("2026-07-11 18:02 GMT+8");
    expect(Array.from(
      query<HTMLSelectElement>("#relation-action").options,
      (option) => option.value,
    )).toContain("custom:same-spacing");
    expect(controller.getSnapshot().legacyRecord?.capturedAt).toBe(
      "2026-07-11T10:02:00.000Z",
    );
  });

  test("opens the extension settings from the header gear", async () => {
    const openOptionsPage = vi.fn(async () => undefined);
    await initializePanel(createPanelDependencies(createFakeController(), { openOptionsPage }));

    query<HTMLButtonElement>("#open-settings").click();
    await flushMicrotasks();

    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  test("keeps removal beside the selected target and follows the current selection", async () => {
    const controller = createFakeController();
    await initializePanel(createPanelDependencies(controller));

    const removeSelected = query<HTMLButtonElement>("#remove-selected-item");
    expect(removeSelected.textContent).toBe("Remove selected element");
    expect(removeSelected.disabled).toBe(false);
    expect(removeSelected.getAttribute("aria-label")).toBe("Remove B: button - Cancel");

    removeSelected.click();
    expect(controller.removeItem).toHaveBeenCalledWith("att_cancel");
    expect(controller.selectItem).not.toHaveBeenCalled();

    controller.__setSnapshot({
      selectedItemId: "att_save",
      intent: "Update Save",
    });
    expect(removeSelected.getAttribute("aria-label")).toBe("Remove A: button - Save changes");
    removeSelected.click();
    expect(controller.removeItem).toHaveBeenLastCalledWith("att_save");
  });

  test("disables selected-target removal while no safe mutation target is available", async () => {
    const controller = createFakeController({ selectedItemId: null });
    await initializePanel(createPanelDependencies(controller));

    const removeSelected = query<HTMLButtonElement>("#remove-selected-item");
    expect(removeSelected.disabled).toBe(true);

    controller.__setSnapshot({
      selectedItemId: "att_save",
      sessionMutationPending: true,
    });
    expect(removeSelected.disabled).toBe(true);
  });

  test("keeps agent-safe session rows and selected removal free of full-debug target text", async () => {
    const fullDebug = createCaptureRecord(
      "invite",
      "Invite ada@example.com",
      "full_debug",
    );
    const file = createSessionFile([
      fullDebug,
      createCaptureRecord("cancel", "Cancel", "agent_safe"),
    ]);
    const controller = createFakeController({
      file,
      legacyRecord: fullDebug,
      selectedItemId: "att_invite",
      viewMode: "agent_safe",
    });

    await initializePanel(createPanelDependencies(controller));

    const sessionText = query("#session-list").textContent ?? "";
    const selectedTargetText = query("#selected-target-summary").textContent ?? "";
    const selectedTargetDetailsText = query("#selected-target-details").textContent ?? "";
    const relationText = query("#relation-composer").textContent ?? "";
    const removeLabel = query<HTMLButtonElement>("#remove-selected-item")
      .getAttribute("aria-label") ?? "";
    expect(sessionText).toContain("Invite [redacted:email]");
    expect(sessionText).not.toContain("ada@example.com");
    expect(removeLabel).not.toContain("ada@example.com");
    expect(selectedTargetText).toBe("Editing A · button");
    expect(selectedTargetDetailsText).toContain("Invite [redacted:email]");
    expect(selectedTargetDetailsText).not.toContain("ada@example.com");
    expect(relationText).toContain("Cancel");
    expect(relationText).not.toContain("ada@example.com");
    expect(fullDebug.attachment.element.accessibleName).toBe("Invite ada@example.com");
  });

  test("offers one optional relationship combobox flow with one apply action", async () => {
    const controller = createFakeController({
      selectedItemId: "att_save",
      intent: "",
      intentDirty: false,
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query<HTMLElement>("#relation-composer").hidden).toBe(false);
    expect(query<HTMLSelectElement>("#relation-reference").value).toBe("att_cancel");
    expect(document.querySelector("#relation-source")).toBeNull();
    expect(document.querySelector("#swap-relation-targets")).toBeNull();
    expect(document.querySelector("[data-relation-action]")).toBeNull();
    expect(PANEL_HTML).toMatch(/id="apply-relation"[\s\S]*?class="relation-apply utility-action"/);
    expect(Array.from(query<HTMLSelectElement>("#relation-reference").options, (option) => option.text))
      .toEqual(["B · button - Cancel"]);
    expect(Array.from(
      query<HTMLSelectElement>("#relation-action").options,
      (option) => ({ value: option.value, text: option.text }),
    )).toEqual([
      { value: "below", text: "Below" },
      { value: "above", text: "Above" },
      { value: "left-of", text: "Left of" },
      { value: "right-of", text: "Right of" },
      { value: "align-left", text: "Align left" },
      { value: "match-width", text: "Match width" },
    ]);

    query<HTMLButtonElement>("#apply-relation").click();

    expect(controller.setIntent).toHaveBeenLastCalledWith("Move A below B.");
    expect(query<HTMLTextAreaElement>("#intent").value).toBe("Move A below B.");
    expect(query<HTMLTextAreaElement>("#markdown").value).toContain(
      "## User Intent\n\nMove A below B.",
    );
    expect(query<HTMLButtonElement>("#change-generated-relation").hidden).toBe(false);
    expect(query<HTMLButtonElement>("#change-generated-relation").disabled).toBe(false);
    expect(query<HTMLButtonElement>("#change-generated-relation").textContent).toBe(
      "Change shortcut",
    );

    query<HTMLButtonElement>("#change-generated-relation").click();

    expect(controller.setIntent).toHaveBeenLastCalledWith("");
    expect(query<HTMLTextAreaElement>("#intent").value).toBe("");
    expect(query<HTMLTextAreaElement>("#markdown").value).not.toContain("Move A below B.");
    expect(query<HTMLButtonElement>("#change-generated-relation").hidden).toBe(true);
    expect(query<HTMLSelectElement>("#relation-action").disabled).toBe(false);
    expect(query<HTMLSelectElement>("#relation-reference").disabled).toBe(false);
    expect(query<HTMLButtonElement>("#apply-relation").disabled).toBe(false);
    expect(document.activeElement).toBe(query<HTMLSelectElement>("#relation-action"));
  });

  test("adds custom task-note shortcuts after the built-ins and fills their exact template", async () => {
    const controller = createFakeController({
      selectedItemId: "att_save",
      intent: "",
      intentDirty: false,
    });
    await initializePanel(createPanelDependencies(controller, {
      relationShortcuts: {
        read: async () => [{
          id: "same-spacing",
          label: "Keep spacing",
          template: "Keep {selected} the same distance from {reference}.",
        }],
      },
    }));

    expect(Array.from(
      query<HTMLSelectElement>("#relation-action").options,
      (option) => ({ value: option.value, text: option.text }),
    ).at(-1)).toEqual({
      value: "custom:same-spacing",
      text: "Keep spacing",
    });

    setSelect("#relation-action", "custom:same-spacing");
    query<HTMLButtonElement>("#apply-relation").click();

    expect(controller.setIntent).toHaveBeenLastCalledWith(
      "Keep A the same distance from B.",
    );
    expect(query<HTMLTextAreaElement>("#intent").value).toBe(
      "Keep A the same distance from B.",
    );
  });

  test("uses captured-target cards as the sole selector and summarizes the active task target", async () => {
    const controller = createFakeController();
    await initializePanel(createPanelDependencies(controller));

    expect(document.querySelector("#selected-target")).toBeNull();
    expect(query("#selected-target-summary").textContent).toBe(
      "Editing B · button",
    );
    expect(query<HTMLDetailsElement>("#selected-target-details").open).toBe(false);
    expect(query("#selected-target-full").textContent).toBe("B · button - Cancel");
    expect(query("#selected-target-captured-at").textContent).toBe("2026-07-11 10:02 UTC");
    expect(query("#selected-target-source").textContent).toBe("Full debug");
    expect(queryOptional('[data-item-id="att_cancel"] .session-meta')).toBeNull();
    expect(query<HTMLButtonElement>('[data-item-id="att_cancel"]').getAttribute("aria-pressed"))
      .toBe("true");

    query<HTMLButtonElement>('[data-item-id="att_save"]').click();

    expect(controller.selectItem).toHaveBeenCalledWith("att_save");

    query<HTMLDetailsElement>("#selected-target-details").open = true;
    controller.__setSnapshot({ selectedItemId: "att_save" });
    await flushMicrotasks();
    expect(query("#selected-target-summary").textContent).toBe(
      "Editing A · button",
    );
    expect(query<HTMLDetailsElement>("#selected-target-details").open).toBe(false);
    expect(query("#selected-target-full").textContent).toBe("A · button - Save changes");
    expect(query<HTMLButtonElement>('[data-item-id="att_save"]').getAttribute("aria-pressed"))
      .toBe("true");
  });

  test("bounds relationship option labels while keeping complete text in target details", async () => {
    const longName =
      "Historic wildfires are tearing across southwestern Europe while evacuations continue";
    const longTarget = createCaptureRecord("long-target", longName, "agent_safe");
    const selected = createCaptureRecord("selected", "Reply", "agent_safe");
    const file = createSessionFile([longTarget, selected]);
    const controller = createFakeController({
      file,
      legacyRecord: selected,
      selectedItemId: "att_selected",
    });
    await initializePanel(createPanelDependencies(controller));

    const fullLabel = `A · button - ${longName}`;
    const relationOption = Array.from(
      query<HTMLSelectElement>("#relation-reference").options,
    ).find((option) => option.value === "att_long-target");

    expect(relationOption?.text).toMatch(/…$/u);
    expect(relationOption?.text.length).toBeLessThan(fullLabel.length);
    expect(relationOption?.title).toBe(fullLabel);
    expect(relationOption?.getAttribute("aria-label")).toBe(fullLabel);

    controller.__setSnapshot({
      selectedItemId: "att_long-target",
      legacyRecord: longTarget,
    });
    await flushMicrotasks();
    expect(query("#selected-target-summary").textContent).toBe(
      "Editing A · button",
    );
    expect(query("#selected-target-full").textContent).toBe(fullLabel);
  });

  test("never infers change permission from restored or manually touched relation text", async () => {
    const restoredController = createFakeController({
      intent: "Move A below B.",
      intentDirty: false,
    });
    await initializePanel(createPanelDependencies(restoredController));

    expect(query<HTMLButtonElement>("#change-generated-relation").hidden).toBe(true);
    expect(query<HTMLButtonElement>("#change-generated-relation").disabled).toBe(true);
    query<HTMLButtonElement>("#change-generated-relation").click();
    expect(restoredController.setIntent).not.toHaveBeenCalled();

    document.body.innerHTML = createPanelDom();
    const generatedController = createFakeController({ intent: "", intentDirty: false });
    await initializePanel(createPanelDependencies(generatedController));
    query<HTMLButtonElement>("#apply-relation").click();
    expect(query<HTMLButtonElement>("#change-generated-relation").hidden).toBe(false);

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Move A below B.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    expect(query<HTMLButtonElement>("#change-generated-relation").hidden).toBe(true);
    expect(query<HTMLButtonElement>("#change-generated-relation").disabled).toBe(true);
    query<HTMLButtonElement>("#change-generated-relation").click();
    expect(generatedController.setIntent).toHaveBeenLastCalledWith("Move A below B.");
  });

  test("withholds change permission when the current session has no epoch", async () => {
    const controller = createFakeController({
      epoch: null,
      intent: "",
      intentDirty: false,
    });
    await initializePanel(createPanelDependencies(controller));

    query<HTMLButtonElement>("#apply-relation").click();

    expect(controller.setIntent).toHaveBeenLastCalledWith("Move B below A.");
    expect(query<HTMLButtonElement>("#change-generated-relation").hidden).toBe(true);
    expect(query<HTMLButtonElement>("#change-generated-relation").disabled).toBe(true);
    query<HTMLButtonElement>("#change-generated-relation").click();
    expect(controller.setIntent).toHaveBeenLastCalledWith("Move B below A.");
  });

  test("shows automatic context labels for same-name targets across rows and relationship choices", async () => {
    const billing = createCaptureRecord("billing-save", "Save changes", "agent_safe");
    billing.attachment.context.parentSummary = "section Billing settings";
    const profile = createCaptureRecord("profile-save", "Save changes", "agent_safe");
    profile.attachment.context.parentSummary = "section Profile settings";
    const file = createSessionFile([billing, profile]);
    const controller = createFakeController({
      file,
      legacyRecord: profile,
      selectedItemId: "att_profile-save",
      intent: "",
      intentDirty: false,
    });

    await initializePanel(createPanelDependencies(controller));

    expect(query("#session-list").textContent).toContain(
      "A · button - Save changes · Billing settings",
    );
    expect(query("#session-list").textContent).toContain(
      "B · button - Save changes · Profile settings",
    );
    expect(query<HTMLButtonElement>("#remove-selected-item").getAttribute("aria-label")).toBe(
      "Remove B: button - Save changes · Profile settings",
    );
    expect(Array.from(
      query<HTMLSelectElement>("#relation-reference").options,
      (option) => option.text,
    )).toEqual([
      "A · button - Save changes · Billing settings",
    ]);
  });

  test("keeps current-page same-name relationship choices clear despite another-route duplicates", async () => {
    const billing = { ...createCaptureRecord("billing-save", "Save changes"), tabId: 7, frameId: 0 };
    billing.attachment.context.parentSummary = "section Billing settings";
    const profile = { ...createCaptureRecord("profile-save", "Save changes"), tabId: 7, frameId: 0 };
    profile.attachment.context.parentSummary = "section Profile settings";
    const otherBilling = {
      ...createCaptureRecord("other-billing-save", "Save changes"),
      tabId: 7,
      frameId: 0,
      pageUrl: `${ORIGIN}/billing`,
    };
    otherBilling.attachment.context.parentSummary = "section Billing settings";
    const file = createSessionFile([billing, profile, otherBilling]);
    const controller = createFakeController({
      activePage: {
        tabId: 7,
        frameId: 0,
        origin: ORIGIN,
        pathname: "/settings",
        documentId: "document-01234567",
      },
      file,
      legacyRecord: profile,
      selectedItemId: "att_profile-save",
      intent: "",
      intentDirty: false,
    });

    await initializePanel(createPanelDependencies(controller));

    expect(Array.from(
      query<HTMLSelectElement>("#relation-reference").options,
      (option) => option.text,
    )).toEqual([
      "A · button - Save changes · Billing settings",
    ]);
  });

  test("uses the current selected element as the relationship source", async () => {
    const controller = createFakeController({ intent: "", intentDirty: false });
    await initializePanel(createPanelDependencies(controller));
    const statusBeforeChange = query("#status").textContent;
    changeSelect("#relation-action", "above");

    expect(query("#selected-target-summary").textContent).toBe(
      "Editing B · button",
    );
    expect(query<HTMLSelectElement>("#relation-reference").value).toBe("att_save");
    expect(query<HTMLSelectElement>("#relation-action").value).toBe("above");
    expect(query("#relation-role-summary").textContent).toBe(
      "Task element: B · Reference element: A",
    );
    expect(query("#status").textContent).toBe(statusBeforeChange);
    expect(controller.setIntent).not.toHaveBeenCalled();

    query<HTMLButtonElement>("#apply-relation").click();

    expect(controller.setIntent).toHaveBeenLastCalledWith("Move B above A.");
    expect(query("#relation-apply-status").textContent).toBe(
      "Task note added to B; A is used only as a reference.",
    );
    expect(query<HTMLElement>("#relation-apply-status").hidden).toBe(false);
  });

  test("keeps a multi-element note attached only to the current task element", async () => {
    const first = createCaptureRecord("first", "First reference");
    const task = createCaptureRecord("task", "Task target");
    const second = createCaptureRecord("second", "Second reference");
    first.intent = "";
    task.intent = "";
    second.intent = "";
    const controller = createFakeController({
      file: createSessionFile([first, task, second]),
      legacyRecord: task,
      selectedItemId: task.attachment.id,
      intent: "",
    });
    await initializePanel(createPanelDependencies(controller));

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Place B between A and C.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    expect(query('[data-item-id="att_first"] .session-intent-status').textContent).toBe(
      "No standalone task",
    );
    expect(query('[data-item-id="att_task"] .session-intent-status').textContent).toBe(
      "Has task note",
    );
    expect(query('[data-item-id="att_second"] .session-intent-status').textContent).toBe(
      "No standalone task",
    );
  });

  test("expands current-page targets, collapses other routes, and limits relationship choices", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    save.pageUrl = `${ORIGIN}/settings?token=secret#billing`;
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    account.attachment.source.url = account.pageUrl;
    const embedded = { ...createCaptureRecord("embedded", "Embedded"), tabId: 7, frameId: 2 };
    embedded.pageUrl = `${ORIGIN}/embed`;
    const otherTab = { ...createCaptureRecord("other", "Other tab"), tabId: 8, frameId: 0 };
    const file = createSessionFile([save, cancel, account, embedded, otherTab]);
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      intent: "",
    });
    const clipboard = { writeText: vi.fn(async () => undefined) };

    await initializePanel(createPanelDependencies(controller, { clipboard }));

    expect(query("#session-count").textContent).toBe(
      "2 on this page · 3 elsewhere · 5 total",
    );
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe("Copy for agent (2)");
    expect(query("#handoff-scope-summary").textContent).toBe(
      "2 targets from the selected page will be copied. Task notes are included for 1 of 2 elements; the remaining element provides page context or serves as a reference without a standalone task. 3 saved elsewhere are excluded.",
    );
    expect(query('[data-item-id="att_save"] .session-intent-status').textContent).toBe(
      "Has task note",
    );
    expect(query('[data-item-id="att_save"] .session-intent-status').dataset.state).toBe(
      "complete",
    );
    expect(query('[data-item-id="att_cancel"] .session-intent-status').textContent).toBe(
      "No standalone task",
    );
    expect(query('[data-item-id="att_cancel"] .session-intent-status').dataset.state).toBe(
      "missing",
    );
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain("Save changes");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain("Cancel");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).not.toContain("Account");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).not.toContain("Embedded");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).not.toContain("Other tab");
    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(
      query<HTMLTextAreaElement>("#agent-handoff-text").value,
    );
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).not.toContain('Target: button "Account"');
    const groups = Array.from(document.querySelectorAll<HTMLDetailsElement>("[data-session-group-key]"));
    expect(groups.map((group) => ({
      label: group.querySelector("summary")?.textContent,
      open: group.open,
      ariaLabel: group.querySelector("summary")?.getAttribute("aria-label"),
    }))).toEqual([
      {
        label: "Current page · /settings2",
        open: true,
        ariaLabel: "Current page · /settings, 2 targets",
      },
      {
        label: "Other page · /account1",
        open: false,
        ariaLabel: "Other page · /account, 1 target",
      },
      {
        label: "Embedded frame · /embed1",
        open: false,
        ariaLabel: "Embedded frame · /embed, 1 target",
      },
      {
        label: "Other tab · /settings1",
        open: false,
        ariaLabel: "Other tab · /settings, 1 target",
      },
    ]);
    expect(Array.from(query<HTMLSelectElement>("#relation-reference").options, (option) => option.value)).toEqual([
      "att_save",
    ]);
    expect(Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-item-id]"),
      (button) => button.dataset.itemId,
    )).toEqual([
      "att_save",
      "att_cancel",
      "att_account",
      "att_embedded",
      "att_other",
    ]);
    expect(query("#session-list").textContent).not.toContain("token=secret");
    expect(query("#session-list").textContent).not.toContain("#billing");

    controller.__setSnapshot({
      selectedItemId: "att_other",
      legacyRecord: otherTab,
      intent: "",
    });
    await flushMicrotasks();
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe(
      "Copy for agent (1)",
    );
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      'Target: button "Other tab"',
    );
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).not.toContain(
      'Target: button "Save changes"',
    );
    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(
      query<HTMLTextAreaElement>("#agent-handoff-text").value,
    );
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toContain(
      'Target: button "Other tab"',
    );
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).not.toContain(
      'Target: button "Save changes"',
    );

    controller.__setSnapshot({
      selectedItemId: "att_account",
      legacyRecord: account,
      intent: "Update Account",
    });
    await flushMicrotasks();
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe(
      "Copy for agent (1)",
    );
    expect(query<HTMLElement>("#handoff-options").hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(false);
    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("exact");
    expect(query("#handoff-scope-summary").textContent).toBe(
      "1 target from the selected page will be copied. Every element has its own task note. 4 saved elsewhere are excluded.",
    );
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      'Target: button "Account"',
    );
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).not.toContain(
      'Target: button "Save changes"',
    );
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "route `https://app.example.test/account`",
    );
    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(
      query<HTMLTextAreaElement>("#agent-handoff-text").value,
    );
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toContain('Target: button "Account"');
  });

  test("separates capture-time replay evidence from current-page rebind truth", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const file = createSessionFile([save, cancel]);
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
    });
    const currentRebind = {
      read: vi.fn(async () => ({
        origin: ORIGIN,
        pathname: "/settings",
        items: [
          { itemId: "att_save", status: "restored" as const },
          { itemId: "att_cancel", status: "missing" as const },
        ],
      })),
    };

    await initializePanel(createPanelDependencies(controller, { currentRebind }));
    await flushMicrotasks();

    const saveStatus = query<HTMLButtonElement>('[data-item-id="att_save"]')
      .querySelector<HTMLElement>(".session-rebind-status");
    const cancelStatus = query<HTMLButtonElement>('[data-item-id="att_cancel"]')
      .querySelector<HTMLElement>(".session-rebind-status");
    expect(saveStatus).toBeNull();
    expect(cancelStatus?.textContent).toBe(
      "Current page: target not found. Select Add elements to capture it again, then remove this stale item.",
    );
    expect(query("#selected-target-rebind-status").textContent).toBe(
      "Current page: target not found. Select Add elements to capture it again, then remove this stale item.",
    );
    expect(query("#locator-summary").textContent).toContain("capture-time replay verified");
    expect(query("#locator-summary").textContent).toContain("Current page: target not found");
    expect(query<HTMLButtonElement>("#element-selection-toggle").textContent).toBe("Add elements");
  });

  test("publishes the verified live page scope for restored capture-time cross-view targets", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    account.attachment.source.url = account.pageUrl;
    let resolveRebind!: (value: {
      origin: string;
      pathname: string;
      documentId: string;
      items: Array<{ itemId: string; status: "restored" | "missing" }>;
    }) => void;
    const currentRebind = {
      read: vi.fn(() => new Promise<{
        origin: string;
        pathname: string;
        documentId: string;
        items: Array<{ itemId: string; status: "restored" | "missing" }>;
      }>((resolve) => { resolveRebind = resolve; })),
    };
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const controller = createFakeController({
      activePage: {
        tabId: 7,
        frameId: 0,
        origin: ORIGIN,
        pathname: "/settings",
      },
      file: createSessionFile([save, cancel, account]),
      legacyRecord: save,
      selectedItemId: "att_save",
    });

    await initializePanel(createPanelDependencies(controller, { currentRebind, localBridge }));
    await flushMicrotasks();
    expect(localBridge.publish.mock.calls.at(-1)?.[0]).not.toHaveProperty("observations");

    const publishCountBeforeObservation = localBridge.publish.mock.calls.length;
    resolveRebind({
      origin: ORIGIN,
      pathname: "/settings",
      documentId: "document-01234567",
      items: [
        { itemId: "att_save", status: "restored" },
        { itemId: "att_cancel", status: "missing" },
        { itemId: "att_account", status: "restored" },
      ],
    });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(localBridge.publish.mock.calls.length).toBeGreaterThan(publishCountBeforeObservation);
    expect(localBridge.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: `${ORIGIN}/settings`,
      },
      observations: {
        observedAt: "2026-07-11T12:34:56.789Z",
        documentInstanceId: "document-01234567",
        targets: [
          { attachmentId: "att_save", status: "restored" },
          { attachmentId: "att_account", status: "restored" },
        ],
      },
    });
    expect(query("#local-bridge-status").dataset.observationState).toBe("published");
    expect(query("#local-bridge-status").dataset).toMatchObject({
      observationDocumentIdLength: "17",
      observationDocumentIdSchemaValid: "true",
      observationObservedAtValid: "true",
      observationPayloadValid: "true",
      observationPublishAttempts: "1",
      observationPublishSettled: "1",
      observationTargetCount: "2",
      observationTargetsValid: "true",
    });

    controller.__setSnapshot({ selectedItemId: "att_account", legacyRecord: account });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(localBridge.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      page: { route: `${ORIGIN}/settings` },
      attachmentCount: 2,
      observations: {
        targets: [
          { attachmentId: "att_save", status: "restored" },
          { attachmentId: "att_account", status: "restored" },
        ],
      },
    });
    expect(query("#local-bridge-status").dataset.observationState).toBe("published");
  });

  test("omits completion observations when the active document identity is unavailable", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const currentRebind = {
      read: vi.fn(async () => ({
        origin: ORIGIN,
        pathname: "/settings",
        items: [{ itemId: "att_save", status: "restored" as const }],
      })),
    };

    await initializePanel(createPanelDependencies(createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
    }), { currentRebind, localBridge }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(localBridge.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      page: { route: `${ORIGIN}/settings` },
      attachmentCount: 1,
    });
    expect(localBridge.publish.mock.calls.at(-1)?.[0]).not.toHaveProperty("observations");
    expect(query("#local-bridge-status").dataset.observationState).toBe("document_unbound");
  });

  test("rejects rebind observations whose returned page identity does not match", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const currentRebind = {
      read: vi.fn(async () => ({
        origin: ORIGIN,
        pathname: "/account",
        items: [{ itemId: "att_save", status: "restored" as const }],
      })),
    };

    await initializePanel(createPanelDependencies(createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
    }), { currentRebind, localBridge }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(localBridge.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      page: { route: `${ORIGIN}/settings` },
      attachmentCount: 1,
    });
    expect(localBridge.publish.mock.calls.at(-1)?.[0]).not.toHaveProperty("observations");
  });

  test("ignores delayed rebind truth after the active page changes", async () => {
    const settings = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    const settingsResolvers: Array<() => void> = [];
    const currentRebind = {
      read: vi.fn((activePage: { pathname: string }) => activePage.pathname === "/settings"
        ? new Promise<null>((resolve) => settingsResolvers.push(() => resolve(null)))
        : Promise.resolve({
            origin: ORIGIN,
            pathname: "/account",
            items: [{ itemId: "att_save", status: "restored" as const }],
          })),
    };
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file: createSessionFile([settings]),
      legacyRecord: settings,
      selectedItemId: "att_save",
    });

    await initializePanel(createPanelDependencies(controller, { currentRebind }));
    controller.__setSnapshot({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/account" },
      file: createSessionFile([account]),
      legacyRecord: account,
      selectedItemId: "att_save",
    });
    await flushMicrotasks();
    expect(query(".session-rebind-status").textContent).toBe("Current page: target restored.");

    for (const resolve of settingsResolvers) resolve();
    await flushMicrotasks();
    expect(query(".session-rebind-status").textContent).toBe("Current page: target restored.");
  });

  test("keeps one current-page status request in flight when the content response is slow", async () => {
    const restoredStatus = {
      origin: ORIGIN,
      pathname: "/settings",
      items: [{ itemId: "att_save", status: "restored" as const }],
    };
    const resolvers: Array<(data: typeof restoredStatus) => void> = [];
    const currentRebind = {
      read: vi.fn(() => new Promise<typeof restoredStatus>((resolve) => resolvers.push(resolve))),
    };
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
    });

    await initializePanel(createPanelDependencies(controller, {
      currentRebind,
      setInterval: (callback, delay) => window.setInterval(callback, delay),
    }));
    vi.advanceTimersByTime(3_000);
    expect(currentRebind.read).toHaveBeenCalledTimes(1);

    resolvers[0]?.(restoredStatus);
    await flushMicrotasks();
    expect(query(".session-rebind-status").textContent).toBe("Current page: target restored.");
  });

  test("fails closed instead of copying the origin session when selection is stale", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const clipboard = { writeText: vi.fn(async () => undefined) };
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file: createSessionFile([save, cancel]),
      legacyRecord: cancel,
      selectedItemId: "att_stale",
    });

    await initializePanel(createPanelDependencies(controller, { clipboard }));

    expect(query<HTMLButtonElement>("#copy-summary").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe("Copy for agent");
    expect(query<HTMLElement>("#handoff-scope-summary").hidden).toBe(true);
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toBe("");
    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("shows a current-page empty state and hides relationship shortcuts when captures are elsewhere", async () => {
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    const file = createSessionFile([account, {
      ...createCaptureRecord("billing", "Billing"),
      tabId: 7,
      frameId: 0,
      pageUrl: `${ORIGIN}/billing`,
    }]);
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file,
      legacyRecord: account,
      selectedItemId: null,
      intent: "",
    });

    await initializePanel(createPanelDependencies(controller));

    expect(query(".session-empty-current").textContent).toBe("No targets captured on this page yet.");
    expect(query<HTMLElement>("#relation-composer").hidden).toBe(true);
    expect(Array.from(document.querySelectorAll<HTMLDetailsElement>("[data-session-group-key]"), (group) => group.open)).toEqual([
      false,
      false,
    ]);
    expect(query<HTMLButtonElement>("#copy-summary").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#copy-summary").textContent).toBe("Copy for agent");
    expect(query<HTMLElement>("#handoff-scope-summary").hidden).toBe(true);
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toBe("");
  });

  test("hides the relationship shortcut until two elements exist", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const file = createSessionFile([save]);
    const controller = createFakeController({
      file,
      legacyRecord: save,
      selectedItemId: "att_save",
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#selected-target-summary").textContent).toBe(
      "Editing A · button",
    );
    expect(query<HTMLButtonElement>('[data-item-id="att_save"]').getAttribute("aria-pressed"))
      .toBe("true");
    expect(query<HTMLElement>("#relation-composer").hidden).toBe(true);
    expect(query<HTMLSelectElement>("#relation-action").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#apply-relation").disabled).toBe(true);
  });

  test("copies current intent with the displayed disclosure-derived agent summary", async () => {
    const controller = createFakeController();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));
    const statusBeforeCopy = query("#status").textContent;

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Move this below Save.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = clipboard.writeText.mock.calls[0][0];
    expect(copied).toContain("# MeanThis Compact Capture Bundle");
    expect(copied).toContain('"kind":"ui-attach.compact-capture-bundle"');
    expect(copied).toContain('"label":"A","id":"att_save","taskNote":"Update Save changes"');
    expect(copied).toContain('"label":"B","id":"att_cancel","taskNote":"Move this below Save."');
    expect(copied).toContain('"disclosureMode":"agent_safe"');
    expect(copied).not.toContain("## Attachment Map");
    expect(query("#status").textContent).toBe(statusBeforeCopy);
    expect(query("#agent-handoff-copy-status").textContent).toBe(
      "Copied 2 elements for agent.",
    );
  });

  test("keeps single-target copy feedback visible across same-handoff refreshes", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const controller = createFakeController({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Describe target A without taking action.",
    });
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));

    const copyStatus = query<HTMLElement>("#agent-handoff-copy-status");
    const copyNextStep = query<HTMLElement>("#agent-handoff-copy-next-step");
    expect(copyStatus.hidden).toBe(true);
    expect(copyNextStep.hidden).toBe(true);

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(copyStatus.hidden).toBe(false);
    expect(copyStatus.textContent).toBe("Copied agent context.");
    expect(copyNextStep.hidden).toBe(false);
    expect(copyNextStep.textContent).toBe(
      "Paste the handoff into the text agent you want to use. MeanThis does not run page actions.",
    );

    controller.__setSnapshot({
      status: { kind: "ready", message: "Capture ready." },
    });
    await flushMicrotasks();

    expect(query("#status").textContent).toBe("Capture ready.");
    expect(copyStatus.hidden).toBe(false);
    expect(copyStatus.textContent).toBe("Copied agent context.");
    expect(copyNextStep.hidden).toBe(false);

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Describe target A's visible purpose without taking action.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    expect(copyStatus.hidden).toBe(true);
    expect(copyStatus.textContent).toBe("");
    expect(copyNextStep.hidden).toBe(true);
    expect(copyNextStep.textContent).toBe("");
  });

  test("explains the required follow-up when copying context without user intent", async () => {
    const save = createCaptureRecord("save", "Save changes");
    save.intent = "";
    const controller = createFakeController({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "",
    });
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));

    expect(query("#handoff-scope-summary").textContent).toBe(
      "1 target from the selected page will be copied. No standalone task notes are included. "
      + "After pasting, tell the agent what you want it to do.",
    );
    expect(query('[data-item-id="att_save"] .session-intent-status').textContent).toBe(
      "No standalone task",
    );

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Explain what should change.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    expect(query('[data-item-id="att_save"] .session-intent-status').textContent).toBe(
      "Has task note",
    );
    expect(query("#handoff-scope-summary").textContent).toBe(
      "1 target from the selected page will be copied. Every element has its own task note.",
    );

    intent.value = "";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText.mock.calls[0][0]).not.toMatch(/^## User Intent$/mu);
    expect(query("#agent-handoff-copy-next-step").textContent).toBe(
      "Paste the handoff, then tell the agent what you want it to do. "
      + "MeanThis does not run page actions.",
    );
  });

  test("previews the exact multi-element handoff that Copy for agent writes", async () => {
    const controller = createFakeController();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));
    setSelect("#handoff-format", "exact");

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Move this below Save.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    const preview = query<HTMLTextAreaElement>("#agent-handoff-text");
    expect(preview.value).toContain(
      '[{"label":"A","intent":"Update Save changes"},{"label":"B","intent":"Move this below Save."}]',
    );
    expect(preview.value).toContain("# MeanThis Capture Bundle");
    expect(preview.value).toContain("- A (`att_save`)");
    expect(preview.value).toContain("- B (`att_cancel`)");

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenCalledWith(preview.value);
  });

  test("defaults multi-element handoff to compact and keeps exact as an explicit choice", async () => {
    const controller = createFakeController();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));

    const handoffOptions = query<HTMLElement>("#handoff-options");
    const format = query<HTMLSelectElement>("#handoff-format");
    const preview = query<HTMLTextAreaElement>("#agent-handoff-text");
    expect(handoffOptions.hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(false);
    expect(format.disabled).toBe(false);
    expect(format.value).toBe("compact");
    expect(preview.value).toContain("# MeanThis Compact Capture Bundle");
    expect(preview.value).toContain('"kind":"ui-attach.compact-capture-bundle"');
    expect(preview.value).not.toContain("## Attachment Map");

    setSelect("#handoff-format", "exact");

    expect(format.value).toBe("exact");
    expect(preview.value).toContain("# MeanThis Capture Bundle");
    expect(preview.value).not.toContain("# MeanThis Compact Capture Bundle");

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenLastCalledWith(preview.value);
  });

  test("offers compact handoff for one element without changing the exact default", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const controller = createFakeController({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));

    const handoffOptions = query<HTMLElement>("#handoff-options");
    const format = query<HTMLSelectElement>("#handoff-format");
    const preview = query<HTMLTextAreaElement>("#agent-handoff-text");

    expect(handoffOptions.hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(false);
    expect(format.disabled).toBe(false);
    expect(format.value).toBe("exact");
    expect(preview.value).toContain("## Consumer Contract");
    expect(preview.value).not.toContain("# MeanThis Compact Capture");

    setSelect("#handoff-format", "compact");

    expect(format.value).toBe("compact");
    expect(preview.value).toContain("# MeanThis Compact Capture");
    expect(preview.value).toContain("format=ui-attach.compact-singleton.v2");
    expect(preview.value).toContain("primaryLocatorValue=page.getByRole");

    const intent = query<HTMLTextAreaElement>("#intent");
    intent.value = "Shorten this label and keep the action clear.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));

    expect(format.value).toBe("compact");
    expect(preview.value).toContain("# MeanThis Compact Capture");
    expect(preview.value).toContain("Shorten this label and keep the action clear.");

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenLastCalledWith(preview.value);
  });

  test("keeps single and multi format preferences scoped across session changes", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const singleFile = createSessionFile([save]);
    const multiFile = createSessionFile([save, cancel]);
    const controller = createFakeController({
      file: singleFile,
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    await initializePanel(createPanelDependencies(controller));

    const handoffOptions = query<HTMLElement>("#handoff-options");
    const format = query<HTMLSelectElement>("#handoff-format");
    const preview = query<HTMLTextAreaElement>("#agent-handoff-text");

    expect(handoffOptions.hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(false);
    setSelect("#handoff-format", "compact");
    expect(format.value).toBe("compact");

    controller.__setSnapshot({
      file: multiFile,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      intent: "Keep this secondary.",
    });
    expect(format.value).toBe("compact");
    setSelect("#handoff-format", "exact");
    expect(format.value).toBe("exact");

    controller.__setSnapshot({
      file: singleFile,
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    expect(handoffOptions.hidden).toBe(false);
    expect(format.value).toBe("compact");
    expect(preview.value).toContain("# MeanThis Compact Capture");

    controller.__setSnapshot({
      file: null,
      legacyRecord: save,
      selectedItemId: null,
      intent: "Shorten this label.",
    });
    expect(handoffOptions.hidden).toBe(false);
    expect(query<HTMLElement>("#handoff-format-field").hidden).toBe(true);
    expect(format.disabled).toBe(true);
    expect(format.value).toBe("exact");
    expect(preview.value).toContain("## Consumer Contract");

    controller.__setSnapshot({
      file: multiFile,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      intent: "Keep this secondary.",
    });
    expect(handoffOptions.hidden).toBe(false);
    expect(format.value).toBe("exact");
    expect(preview.value).toContain("# MeanThis Capture Bundle");
  });

  test("restores independent single and multi format preferences after panel reopen", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const singleFile = createSessionFile([save]);
    const multiFile = createSessionFile([save, cancel]);
    let stored: PanelHandoffFormatPreferences = {
      singleTarget: "exact",
      multiTarget: "compact",
    };
    const handoffFormatPreferences = {
      read: vi.fn(async () => ({ ...stored })),
      save: vi.fn(async (scope: "single" | "multi", format: "exact" | "compact") => {
        stored = scope === "single"
          ? { ...stored, singleTarget: format }
          : { ...stored, multiTarget: format };
      }),
    };
    const firstController = createFakeController({
      file: singleFile,
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    await initializePanel(createPanelDependencies(firstController, { handoffFormatPreferences }));

    setSelect("#handoff-format", "compact");
    await flushMicrotasks();
    firstController.__setSnapshot({
      file: multiFile,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      intent: "Keep this secondary.",
    });
    setSelect("#handoff-format", "exact");
    await flushMicrotasks();

    expect(handoffFormatPreferences.save).toHaveBeenNthCalledWith(1, "single", "compact");
    expect(handoffFormatPreferences.save).toHaveBeenNthCalledWith(2, "multi", "exact");
    expect(stored).toEqual({ singleTarget: "compact", multiTarget: "exact" });

    document.body.innerHTML = createPanelDom();
    const reopenedController = createFakeController({
      file: singleFile,
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    await initializePanel(createPanelDependencies(reopenedController, {
      handoffFormatPreferences,
    }));

    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("compact");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "# MeanThis Compact Capture",
    );
    reopenedController.__setSnapshot({
      file: multiFile,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      intent: "Keep this secondary.",
    });
    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("exact");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "# MeanThis Capture Bundle",
    );
  });

  test("reverts a format choice when preference persistence fails", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const controller = createFakeController({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    await initializePanel(createPanelDependencies(controller, {
      handoffFormatPreferences: {
        read: async () => ({ singleTarget: "exact", multiTarget: "compact" }),
        save: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
      },
    }));

    setSelect("#handoff-format", "compact");
    await flushMicrotasks();
    await flushMicrotasks();

    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("exact");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "## Consumer Contract",
    );
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
  });

  test("does not let a delayed single-target save failure clobber the active multi-target choice", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const singleSave = createDeferred<void>();
    const controller = createFakeController({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    const handoffFormatPreferences = {
      read: async () => ({ singleTarget: "compact" as const, multiTarget: "compact" as const }),
      save: vi.fn((scope: "single" | "multi") => (
        scope === "single" ? singleSave.promise : Promise.resolve()
      )),
    };
    await initializePanel(createPanelDependencies(controller, { handoffFormatPreferences }));

    setSelect("#handoff-format", "exact");
    await flushMicrotasks();
    controller.__setSnapshot({
      file: createSessionFile([save, cancel]),
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      intent: "Keep this secondary.",
    });
    setSelect("#handoff-format", "exact");
    await flushMicrotasks();
    singleSave.reject(new Error("single storage unavailable"));
    await flushMicrotasks();

    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("exact");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "# MeanThis Capture Bundle",
    );
    controller.__setSnapshot({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("compact");
  });

  test("serializes same-scope saves and ignores a superseded failure", async () => {
    const save = createCaptureRecord("save", "Save changes");
    const firstSave = createDeferred<void>();
    const secondSave = createDeferred<void>();
    const handoffFormatPreferences = {
      read: async () => ({ singleTarget: "compact" as const, multiTarget: "compact" as const }),
      save: vi.fn()
        .mockImplementationOnce(() => firstSave.promise)
        .mockImplementationOnce(() => secondSave.promise),
    };
    const controller = createFakeController({
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
      intent: "Shorten this label.",
    });
    await initializePanel(createPanelDependencies(controller, { handoffFormatPreferences }));

    setSelect("#handoff-format", "exact");
    await flushMicrotasks();
    setSelect("#handoff-format", "compact");
    await flushMicrotasks();

    expect(handoffFormatPreferences.save).toHaveBeenCalledTimes(1);
    firstSave.reject(new Error("first write failed"));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(handoffFormatPreferences.save).toHaveBeenCalledTimes(2);
    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("compact");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "# MeanThis Compact Capture",
    );
    expect(query("#status").textContent).not.toBe("Panel action failed. Try again.");

    secondSave.resolve();
    await flushMicrotasks();
    expect(query<HTMLSelectElement>("#handoff-format").value).toBe("compact");
  });

  test("opens and selects the attempted handoff when clipboard copy fails", async () => {
    const controller = createFakeController();
    const clipboard = { writeText: vi.fn(async () => {
      throw new Error("clipboard denied");
    }) };
    await initializePanel(createPanelDependencies(controller, { clipboard }));

    const disclosure = query<HTMLDetailsElement>("#optional-settings");
    const previewDisclosure = query<HTMLDetailsElement>("#agent-handoff-preview");
    const preview = query<HTMLTextAreaElement>("#agent-handoff-text");
    expect(disclosure.open).toBe(false);
    expect(previewDisclosure.open).toBe(false);
    expect(preview.value).toContain("# MeanThis Compact Capture Bundle");

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(disclosure.open).toBe(true);
    expect(previewDisclosure.open).toBe(true);
    expect(document.activeElement).toBe(preview);
    expect(preview.selectionStart).toBe(0);
    expect(preview.selectionEnd).toBe(preview.value.length);
    expect(query("#status").textContent).toBe(
      "Clipboard write failed. The handoff is selected below for manual copy.",
    );
    expect(query<HTMLElement>("#agent-handoff-copy-next-step").hidden).toBe(true);
  });

  test("restores the attempted handoff when clipboard rejection arrives after the preview changes", async () => {
    let rejectCopy: ((reason?: unknown) => void) | undefined;
    const clipboard = {
      writeText: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectCopy = reject;
      })),
    };
    await initializePanel(createPanelDependencies(createFakeController(), { clipboard }));

    const intent = query<HTMLTextAreaElement>("#intent");
    const preview = query<HTMLTextAreaElement>("#agent-handoff-text");
    intent.value = "Move this below Save.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));
    const attemptedHandoff = preview.value;

    query<HTMLButtonElement>("#copy-summary").click();
    expect(clipboard.writeText).toHaveBeenCalledWith(attemptedHandoff);

    intent.value = "Delete this instead.";
    intent.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preview.value).not.toBe(attemptedHandoff);

    rejectCopy?.(new Error("clipboard denied"));
    await flushMicrotasks();

    expect(preview.value).toBe(attemptedHandoff);
    expect(query<HTMLDetailsElement>("#optional-settings").open).toBe(true);
    expect(query<HTMLDetailsElement>("#agent-handoff-preview").open).toBe(true);
    expect(document.activeElement).toBe(preview);
    expect(preview.selectionStart).toBe(0);
    expect(preview.selectionEnd).toBe(attemptedHandoff.length);
  });

  test("copies the current disclosure-derived record after an external view setting", async () => {
    const record = createCaptureRecord("cancel", "Cancel", "full_debug");
    const file = createSessionFile([record]);
    const controller = createFakeController({
      file,
      legacyRecord: record,
      selectedItemId: "att_cancel",
      intent: record.intent,
    });
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, {
      clipboard,
      previewCopy: {
        read: async () => ({ independent: true, mode: "developer_diagnostic" }),
      },
    }));

    expect(controller.setViewMode).toHaveBeenCalledWith("developer_diagnostic");
    expect(query("#current-content-mode").textContent).toContain("Copy: Developer diagnostic");

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    const copied = clipboard.writeText.mock.calls[0][0];
    expect(copied).toContain("- Policy: developer_diagnostic disclosure, balanced redaction");
    expect(copied).toContain("nearby text: none");
    expect(copied).not.toContain("- Policy: agent_safe disclosure");
    expect(copied).not.toContain("ada@example.com");
  });

  test("syncs page overlays only when captured items or the active target change", async () => {
    const controller = createFakeController();
    const syncOverlays = vi.fn(async () => undefined);
    await initializePanel(createPanelDependencies(controller, { syncOverlays }));

    expect(syncOverlays).toHaveBeenCalledTimes(1);
    expect(syncOverlays).toHaveBeenLastCalledWith(ORIGIN, "att_cancel");

    controller.__setSnapshot({ selectedItemId: "att_save" });
    await flushMicrotasks();
    expect(syncOverlays).toHaveBeenLastCalledWith(ORIGIN, "att_save");

    controller.__setSnapshot({ intent: "Typing should not resync overlays", intentDirty: true });
    await flushMicrotasks();
    expect(syncOverlays).toHaveBeenCalledTimes(2);

    controller.__setSnapshot({
      activePage: {
        tabId: 8,
        frameId: 0,
        origin: ORIGIN,
        pathname: "/settings",
        documentId: "document-reopened-01234567",
      },
    });
    await flushMicrotasks();
    expect(syncOverlays).toHaveBeenCalledTimes(3);
    expect(syncOverlays).toHaveBeenLastCalledWith(ORIGIN, "att_save");
  });

  test("keeps session status truthful when best-effort overlay sync fails", async () => {
    const controller = createFakeController();
    const syncOverlays = vi.fn(async () => {
      throw new Error("content script unavailable");
    });
    await initializePanel(createPanelDependencies(controller, { syncOverlays }));
    await flushMicrotasks();

    expect(query("#status").textContent).toBe(
      "Showing agent_safe view from cached full_debug capture.",
    );
  });

  test("retries an unchanged overlay selection after a transient sync failure", async () => {
    const controller = createFakeController();
    const syncOverlays = vi.fn()
      .mockRejectedValueOnce(new Error("content script unavailable"))
      .mockResolvedValue(undefined);
    await initializePanel(createPanelDependencies(controller, { syncOverlays }));
    await flushMicrotasks();

    controller.__setSnapshot({ intent: "A later render with the same overlay state." });
    await flushMicrotasks();

    expect(syncOverlays).toHaveBeenCalledTimes(2);
    expect(syncOverlays).toHaveBeenLastCalledWith(ORIGIN, "att_cancel");
  });

  test("previews a row on pointer or focus and restores the persisted selection on leave", async () => {
    const controller = createFakeController({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    });
    const previewOverlay = vi.fn(async () => undefined);
    let blurWindow: (() => void) | undefined;
    let hidePanel: (() => void) | undefined;
    await initializePanel(createPanelDependencies(controller, {
      previewOverlay,
      addWindowBlurListener: (listener) => {
        blurWindow = listener;
      },
      addWindowPageHideListener: (listener) => {
        hidePanel = listener;
      },
    }));
    previewOverlay.mockClear();

    const save = query<HTMLButtonElement>("[data-item-id=\"att_save\"]");
    save.dispatchEvent(new Event("pointerenter"));
    save.focus();
    save.dispatchEvent(new Event("pointerleave"));
    await flushMicrotasks();

    expect(previewOverlay).toHaveBeenCalledTimes(1);
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, "att_save");
    expect(controller.selectItem).not.toHaveBeenCalled();

    save.blur();
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);

    save.dispatchEvent(new Event("pointerenter"));
    blurWindow?.();
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);

    save.dispatchEvent(new Event("pointerenter"));
    hidePanel?.();
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);
  });

  test("previews focused relationship selections and clears them on blur or rerender", async () => {
    const controller = createFakeController({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      intent: "",
      intentDirty: false,
    });
    const previewOverlay = vi.fn(async () => undefined);
    await initializePanel(createPanelDependencies(controller, { previewOverlay }));
    previewOverlay.mockClear();

    const reference = query<HTMLSelectElement>("#relation-reference");
    reference.focus();
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, "att_save");

    reference.blur();
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);

    reference.focus();
    controller.__setSnapshot({ intent: "External rerender", intentDirty: true });
    await flushMicrotasks();
    expect(previewOverlay.mock.calls.slice(-2)).toEqual([
      [ORIGIN, "att_save"],
      [ORIGIN, null],
    ]);
    expect(query<HTMLSelectElement>("#relation-reference").disabled).toBe(true);

    query<HTMLSelectElement>("#relation-reference").dispatchEvent(new Event("focus"));
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);
    expect(controller.selectItem).not.toHaveBeenCalled();
  });

  test("previews both relationship targets while the single apply action is hovered or focused", async () => {
    const controller = createFakeController({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      intent: "",
      intentDirty: false,
    });
    const previewOverlay = vi.fn(async () => undefined);
    const previewRelationOverlay = vi.fn(async () => undefined);
    await initializePanel(createPanelDependencies(controller, {
      previewOverlay,
      previewRelationOverlay,
    }));
    previewOverlay.mockClear();
    previewRelationOverlay.mockClear();

    const apply = query<HTMLButtonElement>("#apply-relation");
    apply.dispatchEvent(new Event("pointerenter"));
    await flushMicrotasks();
    expect(previewRelationOverlay).toHaveBeenLastCalledWith(
      ORIGIN,
      "att_cancel",
      "att_save",
    );

    apply.dispatchEvent(new Event("pointerleave"));
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);

    apply.focus();
    await flushMicrotasks();
    expect(previewRelationOverlay).toHaveBeenCalledTimes(2);
    apply.blur();
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);

    apply.focus();
    controller.__setSnapshot({ intent: "External rerender", intentDirty: true });
    await flushMicrotasks();
    expect(previewOverlay).toHaveBeenLastCalledWith(ORIGIN, null);
  });

  test("clears a row preview before rerender and keeps failures out of session status", async () => {
    const controller = createFakeController({
      activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    });
    const previewOverlay = vi.fn(async () => {
      throw new Error("content script unavailable");
    });
    await initializePanel(createPanelDependencies(controller, { previewOverlay }));
    previewOverlay.mockClear();

    query<HTMLButtonElement>("[data-item-id=\"att_save\"]")
      .dispatchEvent(new Event("pointerenter"));
    controller.__setSnapshot({ intent: "Rerender while previewing", intentDirty: true });
    await flushMicrotasks();

    expect(previewOverlay.mock.calls).toEqual([
      [ORIGIN, "att_save"],
      [ORIGIN, null],
    ]);
    expect(query("#status").textContent).toBe(
      "Showing agent_safe view from cached full_debug capture.",
    );
  });

  test("confirms before dirty selected removal and clear while avoiding unconfirmed mutation", async () => {
    const controller = createFakeController({ intentDirty: true, intent: "Unsaved edit" });
    const confirms: string[] = [];
    const deps = createPanelDependencies(controller, {
      confirm: (message) => {
        confirms.push(message);
        return confirms.length === 2;
      },
    });
    await initializePanel(deps);

    query<HTMLButtonElement>("#remove-selected-item").click();
    expect(controller.removeItem).not.toHaveBeenCalled();
    expect(controller.discardDirtyIntent).not.toHaveBeenCalled();

    query<HTMLButtonElement>("#remove-selected-item").click();
    await Promise.resolve();
    expect(controller.discardDirtyIntent).toHaveBeenCalledTimes(1);
    expect(controller.removeItem).toHaveBeenCalledWith("att_cancel");
    expect(confirms[0]).toContain("Discard unsaved intent");
  });

  test("dirty clear confirmation names unsaved intent discard and accepts with one operation id", async () => {
    const controller = createFakeController({ intentDirty: true, intent: "Unsaved edit" });
    const confirms: string[] = [];
    const deps = createPanelDependencies(controller, {
      confirm: (message) => {
        confirms.push(message);
        return confirms.length === 2;
      },
      randomUUID: () => "clear-operation-1",
    });
    await initializePanel(deps);

    query<HTMLButtonElement>("#clear-session").click();
    await flushMicrotasks();
    expect(controller.discardDirtyIntent).not.toHaveBeenCalled();
    expect(controller.clearSession).not.toHaveBeenCalled();

    query<HTMLButtonElement>("#clear-session").click();
    await flushMicrotasks();
    expect(confirms).toEqual([
      "Clear selected elements for this page and its embedded frames? Saved selections for every affected site and unsaved task notes will also be discarded.",
      "Clear selected elements for this page and its embedded frames? Saved selections for every affected site and unsaved task notes will also be discarded.",
    ]);
    expect(controller.discardDirtyIntent).toHaveBeenCalledTimes(1);
    expect(controller.clearSession).toHaveBeenCalledWith("clear-operation-1");
  });

  test("shows dirty recovery controls and disables session mutations and export", async () => {
    const controller = createFakeController({
      recovery: {
        oldOrigin: ORIGIN,
        oldEpoch: "epoch-1",
        itemId: "att_cancel",
        intent: "Unsaved edit",
        pendingOrigin: "https://other.example.test",
      },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#status").textContent).toBe(
      "Active origin changed. Save or discard the pending intent.",
    );
    expect(query<HTMLElement>("#intent-recovery").hidden).toBe(false);
    expect(query<HTMLButtonElement>("#export-session").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#clear-session").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#remove-selected-item").disabled).toBe(true);

    query<HTMLButtonElement>("#retry-intent").click();
    query<HTMLButtonElement>("#discard-intent").click();
    expect(controller.retryDirtyIntent).toHaveBeenCalledTimes(1);
    expect(controller.discardDirtyIntent).toHaveBeenCalledTimes(1);
  });

  test("disables local intent editing during recovery clear pending and no selected session item", async () => {
    const cases: SnapshotOverrides[] = [
      {
        recovery: {
          oldOrigin: ORIGIN,
          oldEpoch: "epoch-1",
          itemId: "att_cancel",
          intent: "Unsaved edit",
          pendingOrigin: "https://other.example.test",
        },
      },
      {
        clearPending: true,
        status: { kind: "saving", message: "A session clear is already in progress." },
      },
      {
        sessionMutationPending: true,
        status: { kind: "saving", message: "Removing session item." },
      },
      {
        file: null,
        legacyRecord: null,
        selectedItemId: null,
        intent: "",
        status: {
          kind: "empty",
          message: "No session for this origin. Capture an element to start one.",
        },
      },
    ];

    for (const overrides of cases) {
      document.body.innerHTML = createPanelDom();
      const controller = createFakeController(overrides);
      await initializePanel(createPanelDependencies(controller));

      expect(query<HTMLTextAreaElement>("#intent").disabled).toBe(true);
      query<HTMLTextAreaElement>("#intent").value = "Local edit should not happen";
      query<HTMLTextAreaElement>("#intent").dispatchEvent(new Event("input", { bubbles: true }));
      expect(controller.setIntent).not.toHaveBeenCalled();
    }
  });

  test("keeps intent editable during normal autosave saving status", async () => {
    const controller = createFakeController({
      status: { kind: "saving", message: "Saving intent." },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query<HTMLTextAreaElement>("#intent").disabled).toBe(false);
    query<HTMLTextAreaElement>("#intent").value = "Autosave edit";
    query<HTMLTextAreaElement>("#intent").dispatchEvent(new Event("input", { bubbles: true }));
    expect(controller.setIntent).toHaveBeenCalledWith("Autosave edit");
  });

  test("renders same-origin legacy preview without enabling session export", async () => {
    const legacyRecord = createCaptureRecord("save", "Save changes", "full_debug");
    const controller = createFakeController({
      file: null,
      legacyRecord,
      selectedItemId: null,
      intent: "",
      status: {
        kind: "empty",
        message: "No session for this origin. Capture an element to start one.",
      },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#status").textContent).toBe(
      "Ready to attach UI. Start with Add elements.",
    );
    expect(query<HTMLElement>("#capture").hidden).toBe(false);
    expect(query("#element-summary").textContent).toBe("button · Save changes");
    expect(query<HTMLButtonElement>("#export-session").disabled).toBe(true);
  });

  test("keeps an embedded-frame capture as an ordinary boundary reference", async () => {
    const record = createCaptureRecord("save", "Documentation");
    record.attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://docs.example.test",
      framePathname: "/reference",
      dominantViewport: true,
    };
    const file = createSessionFile([record]);
    const controller = createFakeController({
      file,
      legacyRecord: record,
      selectedItemId: record.attachment.id,
      intent: record.intent,
    });

    await initializePanel(createPanelDependencies(controller));

    expect(query<HTMLElement>("#capture-boundary").hidden).toBe(false);
    expect(query("#capture-boundary-title").textContent).toBe("Embedded frame");
    expect(query("#capture-boundary-message").textContent).toContain(
      "captured the embedded frame boundary, not its internal page",
    );
    expect(document.querySelector("#select-inside-frame")).toBeNull();
  });

  test("renders a collapsed live frame tree and changes scope without starting selection by default", async () => {
    const controller = createFakeController({
      activePage: {
        tabId: 7,
        frameId: 5,
        origin: "https://app-companion.example.test",
        pathname: "/docs/mcp/reference",
        documentId: "inner-doc",
      },
      origin: "https://app-companion.example.test",
      epoch: null,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      intent: "",
      status: { kind: "empty", message: "No session for this origin." },
    });
    const list = vi.fn(async () => ({
      tabId: 7,
      currentFrameId: 5,
      scopes: [
        {
          frameId: 0,
          parentFrameId: null,
          documentId: "top-doc",
          origin: ORIGIN,
          pathname: "/settings",
          depth: 0,
          requiresHostPermission: false,
          selectable: true,
        },
        {
          frameId: 3,
          parentFrameId: 0,
          documentId: "outer-doc",
          origin: "https://app-companion.example.test",
          pathname: "/embedded",
          depth: 1,
          requiresHostPermission: true,
          selectable: true,
        },
        {
          frameId: 5,
          parentFrameId: 3,
          documentId: "inner-doc",
          origin: "https://app-companion.example.test",
          pathname: "/docs/mcp/reference",
          depth: 2,
          requiresHostPermission: true,
          selectable: true,
        },
      ],
    }));
    const select = vi.fn(async () => false);

    await initializePanel(createPanelDependencies(controller, {
      frameScopes: { list, select },
      frameScopeAutoStart: { read: async () => false },
    }));

    const scope = query<HTMLDetailsElement>("#capture-scope");
    expect(scope.hidden).toBe(false);
    expect(scope.open).toBe(false);
    expect(query("#capture-scope-breadcrumb").textContent).toContain("Top page");
    expect(query("#capture-scope-breadcrumb").textContent).toContain(
      "app-companion.example.test",
    );

    scope.open = true;
    const rows = Array.from(
      query("#capture-scope-tree").querySelectorAll<HTMLButtonElement>("[data-frame-scope-id]"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[2]?.getAttribute("aria-current")).toBe("true");
    rows[1]?.click();
    await flushMicrotasks();

    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 7,
      frameId: 3,
      documentId: "outer-doc",
      origin: "https://app-companion.example.test",
      pathname: "/embedded",
      requiresHostPermission: true,
    }), false);
    expect(scope.open).toBe(false);
    expect(controller.refreshActiveOrigin).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(query("#status").textContent).toBe(
      "Capture scope changed. Choose Add elements when ready.",
    ));
  });

  test("auto-starts after a scope change only when the setting is enabled", async () => {
    const controller = createFakeController();
    const select = vi.fn(async () => true);
    await initializePanel(createPanelDependencies(controller, {
      frameScopes: {
        list: async () => ({
          tabId: 1,
          currentFrameId: 0,
          scopes: [
            {
              frameId: 0,
              parentFrameId: null,
              documentId: "top-doc",
              origin: ORIGIN,
              pathname: "/settings",
              depth: 0,
              requiresHostPermission: false,
              selectable: true,
            },
            {
              frameId: 3,
              parentFrameId: 0,
              documentId: "frame-doc",
              origin: "https://docs.example.test",
              pathname: "/reference",
              depth: 1,
              requiresHostPermission: true,
              selectable: true,
            },
          ],
        }),
        select,
      },
      frameScopeAutoStart: { read: async () => true },
    }));

    query<HTMLDetailsElement>("#capture-scope").open = true;
    query<HTMLButtonElement>('[data-frame-scope-id="3"]').click();
    await flushMicrotasks();

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ frameId: 3 }), true);
    await vi.waitFor(() => expect(
      query<HTMLButtonElement>("#element-selection-toggle").getAttribute("aria-pressed"),
    ).toBe("true"));
  });

  test("keeps an active selection running after a scope change when auto-start is off", async () => {
    const controller = createFakeController();
    const select = vi.fn(async () => true);
    await initializePanel(createPanelDependencies(controller, {
      frameScopes: {
        list: async () => ({
          tabId: 1,
          currentFrameId: 0,
          scopes: [
            {
              frameId: 0,
              parentFrameId: null,
              documentId: "top-doc",
              origin: ORIGIN,
              pathname: "/settings",
              depth: 0,
              requiresHostPermission: false,
              selectable: true,
            },
            {
              frameId: 3,
              parentFrameId: 0,
              documentId: "frame-doc",
              origin: "https://docs.example.test",
              pathname: "/reference",
              depth: 1,
              requiresHostPermission: true,
              selectable: true,
            },
          ],
        }),
        select,
      },
      frameScopeAutoStart: { read: async () => false },
      testClickCapture: { read: async () => true, save: async () => undefined },
    }));

    query<HTMLDetailsElement>("#capture-scope").open = true;
    query<HTMLButtonElement>('[data-frame-scope-id="3"]').click();
    await flushMicrotasks();

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ frameId: 3 }), true);
    expect(query<HTMLButtonElement>("#element-selection-toggle").getAttribute("aria-pressed"))
      .toBe("true");
  });

  test("shows first-capture disclosure before auto-starting a frame scope", async () => {
    const controller = createFakeController();
    let acknowledged = false;
    const select = vi.fn(async () => true);
    const firstCaptureDisclosure: FirstCaptureDisclosureStore = {
      isAcknowledged: vi.fn(async () => acknowledged),
      acknowledge: vi.fn(async () => { acknowledged = true; }),
    };
    await initializePanel(createPanelDependencies(controller, {
      frameScopes: {
        list: async () => ({
          tabId: 1,
          currentFrameId: 0,
          scopes: [
            {
              frameId: 0,
              parentFrameId: null,
              documentId: "top-doc",
              origin: ORIGIN,
              pathname: "/settings",
              depth: 0,
              requiresHostPermission: false,
              selectable: true,
            },
            {
              frameId: 3,
              parentFrameId: 0,
              documentId: "frame-doc",
              origin: "https://docs.example.test",
              pathname: "/reference",
              depth: 1,
              requiresHostPermission: true,
              selectable: true,
            },
          ],
        }),
        select,
      },
      frameScopeAutoStart: { read: async () => true },
      firstCaptureDisclosure,
    }));

    const scope = query<HTMLDetailsElement>("#capture-scope");
    scope.open = true;
    query<HTMLButtonElement>('[data-frame-scope-id="3"]').click();
    await flushMicrotasks();

    expect(query<HTMLDialogElement>("#first-capture-disclosure").open).toBe(true);
    expect(select).not.toHaveBeenCalled();

    query<HTMLButtonElement>("#acknowledge-first-capture").click();
    await flushMicrotasks();

    expect(query<HTMLDialogElement>("#first-capture-disclosure").open).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  test("closes the frame tree on Escape before stopping element selection", async () => {
    const controller = createFakeController();
    let keydownListener: ((event: KeyboardEvent) => void) | null = null;
    await initializePanel(createPanelDependencies(controller, {
      frameScopes: {
        list: async () => ({
          tabId: 1,
          currentFrameId: 0,
          scopes: [
            {
              frameId: 0,
              parentFrameId: null,
              documentId: "top-doc",
              origin: ORIGIN,
              pathname: "/settings",
              depth: 0,
              requiresHostPermission: false,
              selectable: true,
            },
            {
              frameId: 3,
              parentFrameId: 0,
              documentId: "frame-doc",
              origin: "https://docs.example.test",
              pathname: "/reference",
              depth: 1,
              requiresHostPermission: true,
              selectable: true,
            },
          ],
        }),
        select: async () => true,
      },
      addWindowKeyDownListener(listener) {
        keydownListener = listener;
      },
      testClickCapture: { read: async () => true, save: async () => undefined },
    }));

    const scope = query<HTMLDetailsElement>("#capture-scope");
    scope.open = true;
    keydownListener?.(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await flushMicrotasks();

    expect(scope.open).toBe(false);
    expect(controller.refreshActiveOrigin).not.toHaveBeenCalled();
  });

  test("keeps clear retry available while clear-pending state blocks remove and export", async () => {
    const controller = createFakeController({
      clearPending: true,
      status: { kind: "ready", message: "Capture session ready." },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#status").textContent).toBe(
      "Selected elements are still being cleared. Retry before capturing or exporting.",
    );
    expect(query<HTMLButtonElement>("#clear-session").disabled).toBe(false);
    expect(query<HTMLButtonElement>("#export-session").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#remove-selected-item").disabled).toBe(true);
  });

  test("keeps clear retry enabled for a supported clear-pending origin with no rows", async () => {
    const controller = createFakeController({
      activeSupported: true,
      clearPending: true,
      origin: ORIGIN,
      epoch: "epoch-1",
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      status: { kind: "saving", message: "A session clear is already in progress." },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#session-count").textContent).toBe("0 of 26 elements");
    expect(query("#status").textContent).toBe(
      "Selected elements are still being cleared. Retry before capturing or exporting.",
    );
    expect(query<HTMLButtonElement>("#clear-session").disabled).toBe(false);
    expect(query<HTMLButtonElement>("#export-session").disabled).toBe(true);
    expect(queryOptional("[data-remove-item-id=\"att_cancel\"]")).toBeNull();
  });

  test("preserves supported zero-row controller error instead of falling back to no-session copy", async () => {
    const controller = createFakeController({
      activeSupported: true,
      origin: ORIGIN,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      status: { kind: "error", message: "Stored capture session is invalid." },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#status").textContent).toBe("Stored capture session is invalid.");
    expect(query("#status").textContent).not.toContain("Capture an element to start one");
  });

  test("uses hidden capture styling and clears stale selected details after the session becomes empty", async () => {
    expect(PANEL_CSS).toContain(".capture[hidden]");
    expect(PANEL_CSS).toContain("display: none;");
    expect(PANEL_HTML).toContain(
      '<button id="copy-summary" class="copy-action primary-action" type="button" data-i18n="copy_for_agent">Copy for agent</button>',
    );
    expect(query("#copy-summary").textContent).toBe("Copy for agent");

    const controller = createFakeController();
    await initializePanel(createPanelDependencies(controller));

    expect(query<HTMLElement>("#capture").hidden).toBe(false);
    expect(query("#capture").textContent).toContain("Cancel");

    controller.__setSnapshot({
      activeSupported: true,
      origin: ORIGIN,
      file: null,
      legacyRecord: null,
      selectedItemId: null,
      intent: "",
      status: {
        kind: "empty",
        message: "No session for this origin. Capture an element to start one.",
      },
    });

    expect(query<HTMLElement>("#capture").hidden).toBe(true);
    expect(query("#capture").textContent).not.toContain("Cancel");
    expect(query("#element-summary").textContent).toBe("");
    expect(query("#locator-summary").textContent).toBe("");
    expect(query("#captured-at").textContent).toBe("");
    expect(query("#redacted-fields").textContent).toBe("");
    expect(query("#sensitive-hints").textContent).toBe("");
    expect(query("#included-sensitive-fields").textContent).toBe("");
    expect(query<HTMLTextAreaElement>("#intent").value).toBe("");
    expect(query<HTMLTextAreaElement>("#agent-summary").value).toBe("");
    expect(query<HTMLTextAreaElement>("#markdown").value).toBe("");
    expect(query<HTMLTextAreaElement>("#json").value).toBe("");
  });

  test("unsupported active page never renders stale legacy preview or capture-start copy", async () => {
    const legacyRecord = createCaptureRecord("save", "Save changes", "full_debug");
    const controller = createFakeController({
      activeSupported: false,
      origin: null,
      file: null,
      legacyRecord,
      selectedItemId: null,
      status: {
        kind: "empty",
        message: "This page is not supported. Open an HTTP(S) page to capture UI.",
      },
    });
    await initializePanel(createPanelDependencies(controller));

    expect(query("#status").textContent).toBe(
      "This page is not supported. Open an HTTP(S) page to capture UI.",
    );
    expect(query<HTMLElement>("#capture").hidden).toBe(true);
    expect(query("#status").textContent).not.toContain("Capture an element to start one");
  });

  test("denied view upgrade keeps the selected preview visible with denial status", async () => {
    const file = createSessionFile([createCaptureRecord("save", "Save changes", "agent_safe")]);
    const controller = createFakeController({
      file,
      legacyRecord: file.session.attachments[0].sourceRecord as OriginCaptureRecord,
      selectedItemId: "att_save",
      intent: "Update Save changes",
    });
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, {
      clipboard,
      previewCopy: {
        read: async () => ({ independent: true, mode: "full_debug" }),
      },
    }));

    expect(query<HTMLElement>("#capture").hidden).toBe(false);
    expect(query("#element-summary").textContent).toBe("button · Save changes");
    expect(query("#status").textContent).toBe(
      "Capture again with full_debug disclosure to include full debug details.",
    );
    expect(
      controller.getSnapshot().file?.session.attachments[0].sourceRecord.attachment.policy.disclosureMode,
    ).toBe("agent_safe");

    query<HTMLButtonElement>("#copy-summary").click();
    await flushMicrotasks();

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = clipboard.writeText.mock.calls[0][0];
    expect(copied).toContain("- Policy: agent_safe disclosure");
    expect(copied).not.toContain("full_debug disclosure");
    expect(copied).not.toContain("developer_diagnostic disclosure");
    expect(copied).not.toContain("ada@example.com");
    expect(copied).not.toContain("sk-test-1234567890");
  });

  test("derived preview status never overwrites saving, success, or error status truth", async () => {
    const cases: Array<{ status: PanelSessionSnapshot["status"]; expected: string }> = [
      {
        status: { kind: "saving", message: "Saving intent." },
        expected: "Saving session...",
      },
      {
        status: { kind: "success", message: "Intent saved." },
        expected: "Session saved locally.",
      },
      {
        status: { kind: "success", message: "Session item removed." },
        expected: "Session item removed.",
      },
      {
        status: { kind: "success", message: "Session cleared." },
        expected: "Selected elements cleared. The next element you add will be A.",
      },
      {
        status: { kind: "error", message: "Storage write failed." },
        expected: "Storage write failed.",
      },
    ];

    for (const { status, expected } of cases) {
      document.body.innerHTML = createPanelDom();
      await initializePanel(createPanelDependencies(createFakeController({ status })));
      expect(query("#status").textContent).toBe(expected);
    }
  });

  test("confirms risky source export, downloads canonical JSON, and revokes the object URL", async () => {
    const controller = createFakeController();
    const timers: Array<() => void> = [];
    const downloads: string[] = [];
    const urls: string[] = [];
    const revoked: string[] = [];
    const confirms: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      downloads.push(this.download);
      urls.push(this.href);
    });
    controller.readExport = vi.fn(async () => ({
      ok: true,
      value: {
        file: controller.getSnapshot().file!,
        text: "{\"kind\":\"ui-attach.capture-session\"}\n",
        byteLength: 38,
      },
    }));

    const deps = createPanelDependencies(controller, {
      confirm: (message) => {
        confirms.push(message);
        return true;
      },
      createObjectURL: () => "blob:session",
      revokeObjectURL: (url) => revoked.push(url),
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
    });
    await initializePanel(deps);

    query<HTMLButtonElement>("#export-session").click();
    await Promise.resolve();

    expect(confirms[0].split("\n")[0]).toBe(
      "This file preserves original capture data. The current preview mode does not make it Agent-safe.",
    );
    expect(confirms[0]).toContain("This file includes per-item user intent.");
    expect(confirms[0]).toContain("agent_safe: 1");
    expect(confirms[0]).toContain("full_debug: 1");
    expect(downloads).toEqual([
      "meanthis-app.example.test-20260711-123456-789.capture-session.json",
    ]);
    expect(urls).toEqual(["blob:session"]);
    expect(query("#status").textContent).toBe(
      "Export started: meanthis-app.example.test-20260711-123456-789.capture-session.json. " +
        "Check your browser downloads.",
    );

    timers[0]();
    expect(revoked).toEqual(["blob:session"]);
  });

  test("exports agent-safe-only sessions without an extra confirmation", async () => {
    const file = createSessionFile([
      createCaptureRecord("save", "Save changes", "agent_safe"),
      createCaptureRecord("cancel", "Cancel", "agent_safe"),
    ]);
    const controller = createFakeController({
      file,
      legacyRecord: file.session.attachments[1].sourceRecord as OriginCaptureRecord,
      selectedItemId: "att_cancel",
    });
    const downloads: string[] = [];
    const confirms: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    controller.readExport = vi.fn(async () => ({
      ok: true,
      value: {
        file,
        text: "{\"kind\":\"ui-attach.capture-session\"}\n",
        byteLength: 38,
      },
    }));

    await initializePanel(
      createPanelDependencies(controller, {
        confirm: (message) => {
          confirms.push(message);
          return true;
        },
      }),
    );

    query<HTMLButtonElement>("#export-session").click();
    await Promise.resolve();

    expect(confirms).toEqual([]);
    expect(downloads).toEqual([
      "meanthis-app.example.test-20260711-123456-789.capture-session.json",
    ]);
  });

  test("does not download when final export readback reports active-origin mismatch", async () => {
    const controller = createFakeController();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    controller.readExport = vi.fn(async () => ({
      ok: false,
      code: "INVALID_SESSION_FILE",
      error: "Active origin changed. Save or discard the pending intent.",
    }));

    await initializePanel(createPanelDependencies(controller));
    query<HTMLButtonElement>("#export-session").click();
    await Promise.resolve();

    expect(anchorClick).not.toHaveBeenCalled();
    expect(query("#status").textContent).toBe(
      "Active origin changed. Save or discard the pending intent.",
    );
  });

  test("refreshes from runtime session notifications and window focus", async () => {
    const controller = createFakeController();
    const runtimeListeners: Array<(message: unknown) => void> = [];
    await initializePanel(createPanelDependencies(controller, {
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
      addWindowFocusListener: (listener) => window.addEventListener("focus", listener),
    }));

    runtimeListeners[0]({
      type: "ui-attach:session-updated",
      origin: ORIGIN,
      itemId: "att_save",
    });
    runtimeListeners[0]({ type: "ui-attach:active-origin-changed", enabled: true, origin: ORIGIN });
    window.dispatchEvent(new Event("focus"));

    expect(controller.refreshActiveOrigin).toHaveBeenCalledTimes(3);
    expect(controller.refreshActiveOrigin).toHaveBeenNthCalledWith(1, "att_save");
    expect(controller.refreshActiveOrigin).toHaveBeenNthCalledWith(2);
    expect(controller.refreshActiveOrigin).toHaveBeenNthCalledWith(3);
  });

  test("shows toolbar reconnect guidance until the active tab grants access", async () => {
    const controller = createFakeController();
    const runtimeListeners: Array<(message: unknown) => void> = [];
    await initializePanel(createPanelDependencies(controller, {
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    runtimeListeners[0]({
      type: "ui-attach:active-origin-changed",
      accessRequired: true,
      enabled: false,
      origin: null,
    });
    await flushMicrotasks();

    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(false);
    expect(query("#page-access-recovery-heading").textContent).toBe("Reconnect this page");
    expect(query(".page-access-recovery-limit").textContent).toContain(
      "Keep this side panel open",
    );
    expect(query<HTMLButtonElement>("#element-selection-toggle").disabled).toBe(true);
    expect(query("#status").textContent).toBe("Page access is required before selection.");

    runtimeListeners[0]({
      type: "ui-attach:active-origin-changed",
      accessRequired: false,
      enabled: true,
      origin: ORIGIN,
    });
    await flushMicrotasks();

    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(true);
    expect(query<HTMLButtonElement>("#element-selection-toggle").disabled).toBe(false);
  });

  test("runtime capture failures keep special session statuses and report generic failures", async () => {
    const controller = createFakeController();
    const runtimeListeners: Array<(message: unknown) => void> = [];
    await initializePanel(createPanelDependencies(controller, {
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    runtimeListeners[0]({
      type: "ui-attach:capture-failed",
      error: "Unsupported page. Open an HTTP(S) page.",
    });
    expect(query("#status").textContent).toBe(
      "This page cannot be captured. Open a regular HTTP(S) page, then try again.",
    );

    runtimeListeners[0]({
      type: "ui-attach:capture-failed",
      error: "Capture session already contains 26 items.",
    });
    expect(query("#status").textContent).toBe(
      "Session limit reached (26 elements). Remove one or clear the selected elements.",
    );

    runtimeListeners[0]({
      type: "ui-attach:capture-failed",
      error: "A session clear is already in progress.",
    });
    expect(query("#status").textContent).toBe(
      "Selected elements are still being cleared. Retry before capturing or exporting.",
    );
  });

  test("dynamic session row select rejection is caught and reported safely", async () => {
    const controller = createFakeController();
    controller.selectItem = vi.fn(async () => {
      throw new Error("secret select failure");
    });
    await initializePanel(createPanelDependencies(controller));

    query<HTMLButtonElement>("[data-item-id=\"att_save\"]").click();
    await flushMicrotasks();

    expect(controller.selectItem).toHaveBeenCalledWith("att_save");
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
  });

  test("dynamic selected removal rejections are caught and reported safely", async () => {
    const discardController = createFakeController({ intentDirty: true });
    discardController.discardDirtyIntent = vi.fn(async () => {
      throw new Error("secret discard failure");
    });
    await initializePanel(createPanelDependencies(discardController));

    query<HTMLButtonElement>("#remove-selected-item").click();
    await flushMicrotasks();

    expect(discardController.discardDirtyIntent).toHaveBeenCalledTimes(1);
    expect(discardController.removeItem).not.toHaveBeenCalled();
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");

    document.body.innerHTML = createPanelDom();
    const removeController = createFakeController({ selectedItemId: "att_save" });
    removeController.removeItem = vi.fn(async () => {
      throw new Error("secret remove failure");
    });
    await initializePanel(createPanelDependencies(removeController));

    query<HTMLButtonElement>("#remove-selected-item").click();
    await flushMicrotasks();

    expect(removeController.removeItem).toHaveBeenCalledWith("att_save");
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
  });

  test("async UI rejections are caught and reported with a fixed safe status", async () => {
    const controller = createFakeController();
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const deps = createPanelDependencies(controller, {
      openOptionsPage: async () => { throw new Error("secret settings failure"); },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
      addWindowFocusListener: (listener) => window.addEventListener("focus", listener),
    });
    controller.refreshActiveOrigin = vi.fn(async () => {
      throw new Error("secret refresh failure");
    });
    controller.readExport = vi.fn(async () => {
      throw new Error("secret export failure");
    });
    controller.clearSession = vi.fn(async () => {
      throw new Error("secret clear failure");
    });
    await initializePanel(deps);

    query<HTMLButtonElement>("#open-settings").click();
    await flushMicrotasks();
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");

    runtimeListeners[0]({
      type: "ui-attach:session-updated",
      origin: ORIGIN,
      itemId: "att_save",
    });
    await flushMicrotasks();
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");

    window.dispatchEvent(new Event("focus"));
    await flushMicrotasks();
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");

    query<HTMLButtonElement>("#export-session").click();
    await flushMicrotasks();
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");

    query<HTMLButtonElement>("#clear-session").click();
    await flushMicrotasks();
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
  });

  test("bootstrap storage read failure does not reject initializePanel or get overwritten", async () => {
    const controller = createFakeController();
    const deps = createPanelDependencies(controller, {
      captureMode: {
        read: async () => {
          throw new Error("secret storage read failure");
        },
      },
    });

    await expect(initializePanel(deps)).resolves.toBeUndefined();

    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
    controller.setViewMode("full_debug");
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
  });

  test("keeps element selection disabled until panel bootstrap completes", async () => {
    let resolveSelectionRead!: (enabled: boolean) => void;
    const selectionRead = new Promise<boolean>((resolve) => {
      resolveSelectionRead = resolve;
    });
    const staticPanel = new DOMParser().parseFromString(PANEL_HTML, "text/html");
    const staticToggle = staticPanel.querySelector<HTMLButtonElement>("#element-selection-toggle");
    const toggle = query<HTMLButtonElement>("#element-selection-toggle");

    expect(staticToggle?.disabled).toBe(true);

    const initialization = initializePanel(createPanelDependencies(createFakeController(), {
      testClickCapture: {
        read: () => selectionRead,
        save: vi.fn(async () => undefined),
      },
    }));

    await flushMicrotasks();

    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    resolveSelectionRead(false);
    await initialization;

    expect(toggle.disabled).toBe(false);
  });

  test("keeps toolbar reconnect selection disabled when access changes during bootstrap", async () => {
    let resolveSelectionRead!: (enabled: boolean) => void;
    const selectionRead = new Promise<boolean>((resolve) => {
      resolveSelectionRead = resolve;
    });
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const toggle = query<HTMLButtonElement>("#element-selection-toggle");
    const initialization = initializePanel(createPanelDependencies(createFakeController(), {
      testClickCapture: {
        read: () => selectionRead,
        save: vi.fn(async () => undefined),
      },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    }));

    await flushMicrotasks();
    runtimeListeners[0]({
      type: "ui-attach:active-origin-changed",
      accessRequired: true,
      enabled: false,
      origin: null,
    });
    resolveSelectionRead(false);
    await initialization;

    expect(query<HTMLElement>("#page-access-recovery").hidden).toBe(false);
    expect(query("#status").textContent).toBe("Page access is required before selection.");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.disabled).toBe(true);
  });

  test("retries a transient initial element-selection read before disabling the panel", async () => {
    const controller = createFakeController();
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("background listener not ready"))
      .mockResolvedValue(false);

    await initializePanel(createPanelDependencies(controller, {
      testClickCapture: {
        read,
        save: vi.fn(async () => undefined),
      },
    }));

    expect(read).toHaveBeenCalledTimes(2);
    expect(query<HTMLButtonElement>("#open-settings").disabled).toBe(false);
    expect(query("#status").textContent).not.toBe("Panel action failed. Try again.");
  });

  test("retries a transient safe controller bootstrap status before disabling the panel", async () => {
    const controller = createFakeController();
    controller.initialize = vi.fn()
      .mockImplementationOnce(async () => {
        controller.__setSnapshot({
          status: { kind: "error", message: "Panel action failed. Try again." },
        });
      })
      .mockImplementationOnce(async () => {
        controller.__setSnapshot({
          status: { kind: "ready", message: "Capture session ready." },
        });
      });

    await initializePanel(createPanelDependencies(controller));

    expect(controller.initialize).toHaveBeenCalledTimes(2);
    expect(query<HTMLButtonElement>("#open-settings").disabled).toBe(false);
    expect(query("#status").textContent).not.toBe("Panel action failed. Try again.");
  });

  test("post-bootstrap-failure runtime and control attempts cannot replace safe status", async () => {
    const controller = createFakeController();
    const runtimeListeners: Array<(message: unknown) => void> = [];
    const deps = createPanelDependencies(controller, {
      captureMode: {
        read: async () => {
          throw new Error("secret bootstrap failure");
        },
      },
      addRuntimeMessageListener: (listener) => runtimeListeners.push(listener),
    });

    await initializePanel(deps);
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");

    runtimeListeners[0]({
      type: "ui-attach:capture-failed",
      error: "secret capture failure",
    });
    query<HTMLButtonElement>("#open-settings").click();
    query<HTMLTextAreaElement>("#intent").value = "Blocked after bootstrap failure";
    query<HTMLTextAreaElement>("#intent").dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>("#clear-session").click();
    query<HTMLButtonElement>("#export-session").click();
    await flushMicrotasks();

    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
    expect(controller.setViewMode).not.toHaveBeenCalled();
    expect(controller.setIntent).not.toHaveBeenCalled();
    expect(controller.clearSession).not.toHaveBeenCalled();
    expect(controller.readExport).not.toHaveBeenCalled();
    expect(query<HTMLTextAreaElement>("#intent").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#element-selection-toggle").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#open-settings").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#clear-session").disabled).toBe(true);
    expect(query<HTMLButtonElement>("#export-session").disabled).toBe(true);
  });

  test("controller initialize rejection does not reject initializePanel or get overwritten", async () => {
    const controller = createFakeController();
    controller.initialize = vi.fn(async () => {
      throw new Error("secret initialize failure");
    });

    await expect(initializePanel(createPanelDependencies(controller))).resolves.toBeUndefined();

    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
    controller.setViewMode("full_debug");
    expect(query("#status").textContent).toBe("Panel action failed. Try again.");
  });

  test("browser session client converts runtime sendMessage rejection into a safe command failure", async () => {
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      runtime: {
        sendMessage: vi.fn(async () => {
          throw new Error("secret runtime failure");
        }),
      },
    };
    try {
      const deps = createBrowserPanelDependencies();

      await deps.controller.initialize();

      expect(deps.controller.getSnapshot()).toMatchObject({
        status: {
          kind: "error",
          message: "Panel action failed. Try again.",
        },
      });
    } finally {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("reads rebind truth only from the exact active tab and frame", async () => {
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    const sendMessage = vi.fn(async () => ({
      ok: true,
      data: {
        origin: ORIGIN,
        pathname: "/settings",
        items: [{ itemId: "att_save", status: "ambiguous" }],
      },
    }));
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      tabs: { sendMessage },
      webNavigation: {
        getFrame: vi.fn(async () => ({
          frameId: 3,
          parentFrameId: 0,
          url: `${ORIGIN}/settings`,
          documentId: "document-live-76543210",
        })),
      },
      runtime: { sendMessage: vi.fn(async () => undefined) },
    };
    try {
      const deps = createBrowserPanelDependencies() as PanelDependencies & {
        currentRebind: {
          read(activePage: {
            tabId: number;
            frameId: number;
            origin: string;
            pathname: string;
            documentId?: string;
          }): Promise<unknown>;
        };
      };

      await expect(deps.currentRebind.read({
        tabId: 7,
        frameId: 3,
        origin: ORIGIN,
        pathname: "/settings",
        documentId: "document-01234567",
      })).resolves.toEqual({
        origin: ORIGIN,
        pathname: "/settings",
        documentId: "document-live-76543210",
        items: [{ itemId: "att_save", status: "ambiguous" }],
      });
      expect(sendMessage).toHaveBeenCalledWith(7, {
        type: "ui-attach:overlay-rebind-status-get",
      }, { frameId: 3, documentId: "document-live-76543210" });
      sendMessage.mockResolvedValueOnce({
        ok: true,
        data: {
          origin: ORIGIN,
          pathname: "/account",
          items: [{ itemId: "att_save", status: "restored" }],
        },
      });
      await expect(deps.currentRebind.read({
        tabId: 7,
        frameId: 3,
        origin: ORIGIN,
        pathname: "/settings",
      })).resolves.toBeNull();
    } finally {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("uses and releases only the selected cross-origin permission for saved marker restore", async () => {
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    const topOrigin = "https://top.example.test";
    const operations: string[] = [];
    const permissions = {
      contains: vi.fn(async () => {
        operations.push("permissions:contains");
        return false;
      }),
      request: vi.fn(async () => {
        operations.push("permissions:request");
        return true;
      }),
      remove: vi.fn(async () => {
        operations.push("permissions:remove");
        return true;
      }),
    };
    const sendMessage = vi.fn(async (message: unknown) => {
      const type = typeof message === "object" && message !== null && "type" in message
        ? String(message.type)
        : "unknown";
      operations.push(`send:${type}`);
      return type === "ui-attach:saved-session-resolve-route"
        ? {
            ok: true,
            data: { location: "current_page", requiresHostPermission: true },
          }
        : {
            ok: true,
            data: {
              origin: ORIGIN,
              pathname: "/embedded",
              items: [{ itemId: "att_save", status: "restored" }],
            },
          };
    });
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      i18n: undefined,
      permissions,
      runtime: {
        sendMessage,
        openOptionsPage: vi.fn(async () => undefined),
      },
      tabs: {
        create: vi.fn(async ({ url }: { url: string }) => ({ id: 9, url })),
      },
    };
    try {
      const deps = createBrowserPanelDependencies();

      await expect(deps.storedSessions?.restoreRoute?.({
        origin: ORIGIN,
        pathname: "/embedded",
        frameKind: "embedded",
        targetCount: 1,
        topPage: { origin: topOrigin, pathname: "/host" },
        frameChain: [
          { origin: topOrigin, pathname: "/host" },
          { origin: ORIGIN, pathname: "/embedded" },
        ],
      })).resolves.toEqual({
        ok: true,
        data: {
          origin: ORIGIN,
          pathname: "/embedded",
          items: [{ itemId: "att_save", status: "restored" }],
        },
      });

      const pattern = `${ORIGIN}/*`;
      expect(permissions.contains).toHaveBeenCalledWith({ origins: [pattern] });
      expect(permissions.request).toHaveBeenCalledWith({ origins: [pattern] });
      expect(operations.slice(0, 3)).toEqual([
        "permissions:contains",
        "permissions:request",
        "send:ui-attach:saved-session-resolve-route",
      ]);
      expect(sendMessage).toHaveBeenNthCalledWith(1, {
        type: "ui-attach:saved-session-resolve-route",
        origin: ORIGIN,
        pathname: "/embedded",
        frameKind: "embedded",
        routeChain: [
          { origin: topOrigin, pathname: "/host" },
          { origin: ORIGIN, pathname: "/embedded" },
        ],
      });
      expect(sendMessage).toHaveBeenNthCalledWith(2, {
        type: "ui-attach:saved-session-restore-route",
        origin: ORIGIN,
        pathname: "/embedded",
        frameKind: "embedded",
        routeChain: [
          { origin: topOrigin, pathname: "/host" },
          { origin: ORIGIN, pathname: "/embedded" },
        ],
      });
      expect(permissions.remove).toHaveBeenCalledWith({ origins: [pattern] });
    } finally {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("starts embedded permission preflight for legacy saved routes without a frame chain", async () => {
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    const operations: string[] = [];
    const permissions = {
      contains: vi.fn(async () => {
        operations.push("permissions:contains");
        return false;
      }),
      request: vi.fn(async () => {
        operations.push("permissions:request");
        return true;
      }),
      remove: vi.fn(async () => {
        operations.push("permissions:remove");
        return true;
      }),
    };
    const sendMessage = vi.fn(async (message: unknown) => {
      const type = typeof message === "object" && message !== null && "type" in message
        ? String(message.type)
        : "unknown";
      operations.push(`send:${type}`);
      return type === "ui-attach:saved-session-resolve-route"
        ? {
            ok: true,
            data: { location: "current_page", requiresHostPermission: true },
          }
        : {
            ok: true,
            data: {
              origin: ORIGIN,
              pathname: "/embedded",
              items: [{ itemId: "att_save", status: "restored" }],
            },
          };
    });
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      i18n: undefined,
      permissions,
      runtime: {
        sendMessage,
        openOptionsPage: vi.fn(async () => undefined),
      },
      tabs: {
        create: vi.fn(async ({ url }: { url: string }) => ({ id: 9, url })),
      },
    };
    try {
      const deps = createBrowserPanelDependencies();

      await expect(deps.storedSessions?.restoreRoute?.({
        origin: ORIGIN,
        pathname: "/embedded",
        frameKind: "embedded",
        targetCount: 1,
      })).resolves.toMatchObject({ ok: true });

      const pattern = `${ORIGIN}/*`;
      expect(permissions.contains).toHaveBeenCalledWith({ origins: [pattern] });
      expect(permissions.request).toHaveBeenCalledWith({ origins: [pattern] });
      expect(operations.slice(0, 3)).toEqual([
        "permissions:contains",
        "permissions:request",
        "send:ui-attach:saved-session-resolve-route",
      ]);
      expect(permissions.remove).toHaveBeenCalledWith({ origins: [pattern] });
    } finally {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("releases a preflight frame permission when saved route resolution fails", async () => {
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    const permissions = {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => true),
      remove: vi.fn(async () => true),
    };
    const sendMessage = vi.fn(async () => ({
      ok: false,
      code: "SAVED_ROUTE_NOT_OPEN",
      error: "Open the page and try again.",
    }));
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      i18n: undefined,
      permissions,
      runtime: {
        sendMessage,
        openOptionsPage: vi.fn(async () => undefined),
      },
      tabs: {
        create: vi.fn(async ({ url }: { url: string }) => ({ id: 9, url })),
      },
    };
    try {
      const deps = createBrowserPanelDependencies();

      await expect(deps.storedSessions?.restoreRoute?.({
        origin: ORIGIN,
        pathname: "/embedded",
        frameKind: "embedded",
        targetCount: 1,
        topPage: { origin: "https://top.example.test", pathname: "/host" },
        frameChain: [
          { origin: "https://top.example.test", pathname: "/host" },
          { origin: ORIGIN, pathname: "/embedded" },
        ],
      })).resolves.toMatchObject({ ok: false, code: "SAVED_ROUTE_NOT_OPEN" });

      expect(permissions.request).toHaveBeenCalledOnce();
      expect(permissions.remove).toHaveBeenCalledWith({ origins: [`${ORIGIN}/*`] });
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test.each([
    [
      "ACTIVE_PAGE_UNAVAILABLE",
      "Open a regular HTTP(S) page, then select Add elements again.",
    ],
    [
      "CONTENT_UNAVAILABLE",
      "MeanThis cannot reach this page. Reload it, then select Add elements again.",
    ],
    [
      "PERMISSION_DENIED",
      "Page access is required before selection.",
    ],
  ])("browser selection maps %s without exposing background detail", async (code, expected) => {
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = {
      tabs: {
        query: vi.fn(async () => [{ id: 7 }]),
      },
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          code,
          error: "secret background detail",
        })),
      },
    };
    try {
      const deps = createBrowserPanelDependencies() as PanelDependencies & {
        testClickCapture: { save(enabled: boolean): Promise<void> };
      };
      await expect(deps.testClickCapture.save(true)).rejects.toThrow(expected);
    } finally {
      (globalThis as typeof globalThis & { chrome?: unknown }).chrome = previousChrome;
    }
  });

  test("creates and copies a local bridge request only from the explicit panel action", async () => {
    const requestText = [
      "# MeanThis Connection Request",
      "Request ID: 95e3e7b1-6f74-44ae-8954-e11f7f2a7c58",
      "Approval key: DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw",
    ].join("\n");
    const localBridge = {
      readStatus: vi.fn(async () => disconnectedBridgeStatus()),
      createConnectionRequest: vi.fn(async () => ({
        ...disconnectedBridgeStatus(),
        pending: true,
        approvalMode: "ask" as const,
        requestText,
        expiresAt: "2026-07-17T04:32:00.000Z",
      })),
      refreshConnection: vi.fn(async () => disconnectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => disconnectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(createFakeController(), { localBridge, clipboard }));

    expect(localBridge.createConnectionRequest).not.toHaveBeenCalled();
    expect(bridgeStepStates()).toEqual(["current", "upcoming", "upcoming", "upcoming"]);
    expect(query("#local-bridge-status").textContent).toBe(
      "Ready to connect. Start by choosing trust.",
    );
    expect(query("#local-bridge-trust-help").textContent).toBe("Ask for approval each time.");
    expect(query<HTMLElement>("#local-bridge-trust-help").hidden).toBe(false);
    changeSelect("#local-bridge-approval-mode", "browser_session");
    expect(query("#local-bridge-trust-help").textContent).toBe(
      "Keep approval until this browser session ends.",
    );
    query<HTMLButtonElement>("#local-bridge-request").click();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(localBridge.createConnectionRequest).toHaveBeenCalledWith("browser_session");
    expect(clipboard.writeText).toHaveBeenCalledWith(requestText);
    expect(query("#local-bridge-status").textContent).toContain("Request copied");
    expect(query<HTMLTextAreaElement>("#local-bridge-request-text").value).toBe(requestText);
    expect(query<HTMLTextAreaElement>("#local-bridge-request-text").hidden).toBe(false);
    expect(query<HTMLButtonElement>("#local-bridge-disconnect").hidden).toBe(false);
    expect(bridgeStepStates()).toEqual(["complete", "complete", "current", "upcoming"]);
    expect(query<HTMLDetailsElement>("#local-bridge-details").hidden).toBe(false);
    expect(query<HTMLDetailsElement>("#local-bridge-details").open).toBe(false);

    query<HTMLButtonElement>("#local-bridge-request").click();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(localBridge.createConnectionRequest).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);

    query<HTMLButtonElement>("#local-bridge-disconnect").click();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(localBridge.disconnect).toHaveBeenCalledOnce();
    expect(query("#local-bridge-status").dataset.disconnectState).toBe("acknowledged");
    expect(query<HTMLButtonElement>("#local-bridge-disconnect").hidden).toBe(true);
    expect(query<HTMLButtonElement>("#local-bridge-request").hidden).toBe(false);
  });

  test("publishes an agent-safe bridge handoff even while the panel views full debug", async () => {
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const save = { ...createCaptureRecord("save", "Save changes", "agent_safe"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel", "full_debug"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account", "full_debug"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    account.attachment.source.url = account.pageUrl;
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file: createSessionFile([save, cancel, account]),
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
      viewMode: "full_debug",
    });
    await initializePanel(createPanelDependencies(controller, {
      localBridge,
    }));
    await flushMicrotasks();
    await flushMicrotasks();

    const published = localBridge.publish.mock.calls.at(-1)?.[0];
    expect(published).toMatchObject({ attachmentCount: 2 });
    expect(published?.agentCopy).toContain("agent_safe disclosure");
    expect(published?.agentCopy).not.toContain("full_debug disclosure");
    expect(published?.agentCopy).not.toContain('Target: button "Account"');
    expect(published?.agentCopy).not.toContain("route `https://app.example.test/account`");
    expect(published?.capture).toMatchObject({
      captureId: "session-1",
      authority: "capture_time",
      disclosureMode: "agent_safe",
      targets: [
        { attachmentId: "att_save", label: "A" },
        { attachmentId: "att_cancel", label: "B" },
      ],
    });
    expect(JSON.stringify(published?.capture)).not.toContain("att_account");
    expect(JSON.stringify(published?.capture)).not.toContain("ada@example.com");
    expect(JSON.stringify(published?.capture)).not.toContain("sk-test-1234567890");
    expect(bridgeStepStates()).toEqual(["complete", "complete", "complete", "current"]);
    expect(query("#local-bridge-status").textContent).toBe(
      "Connected. Agent-safe page context is available to the local agent.",
    );
    expect(query<HTMLElement>("#local-bridge-trust-field").hidden).toBe(true);
    expect(query<HTMLElement>("#local-bridge-trust-help").hidden).toBe(true);
    expect(query<HTMLDetailsElement>("#local-bridge-details").hidden).toBe(false);
    expect(query("#local-bridge-instance").textContent).toContain("instance-0123456789ab");
  });

  test("keeps local bridge publication exact when the visible handoff uses compact", async () => {
    const controller = createFakeController();
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    await initializePanel(createPanelDependencies(controller, { localBridge }));
    await flushMicrotasks();
    await flushMicrotasks();

    setSelect("#handoff-format", "compact");
    expect(query<HTMLTextAreaElement>("#agent-handoff-text").value).toContain(
      "# MeanThis Compact Capture Bundle",
    );
    localBridge.publish.mockClear();
    controller.__setSnapshot({
      status: { kind: "ready", message: "Capture session refreshed." },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    const published = localBridge.publish.mock.calls.at(-1)?.[0];
    expect(published?.agentCopy).toContain("# MeanThis Capture Bundle");
    expect(published?.agentCopy).not.toContain("# MeanThis Compact Capture Bundle");
  });

  test("publishes an agent-safe bridge handoff for one full-debug element", async () => {
    const record = createCaptureRecord("save", "Save changes", "full_debug");
    const file = createSessionFile([record]);
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    await initializePanel(createPanelDependencies(createFakeController({
      file,
      legacyRecord: record,
      selectedItemId: record.attachment.id,
      viewMode: "full_debug",
    }), { localBridge }));
    await flushMicrotasks();
    await flushMicrotasks();

    const published = localBridge.publish.mock.calls.at(-1)?.[0];
    expect(published).toMatchObject({ attachmentCount: 1 });
    expect(published?.agentCopy).toContain("agent_safe disclosure");
    expect(published?.agentCopy).not.toContain("full_debug disclosure");
    expect(published?.agentCopy).not.toContain("ada@example.com");
    expect(published?.agentCopy).not.toContain("sk-test-1234567890");
    expect(published?.capture).toMatchObject({
      disclosureMode: "agent_safe",
      targets: [{
        attachmentId: "att_save",
        attachment: { policy: { disclosureMode: "agent_safe" } },
      }],
    });
    expect(JSON.stringify(published?.capture)).not.toContain("ada@example.com");
    expect(JSON.stringify(published?.capture)).not.toContain("sk-test-1234567890");
  });

  test("coalesces queued bridge snapshots while keeping routing and scope aligned", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    account.attachment.source.url = account.pageUrl;
    const file = createSessionFile([save, cancel, account]);
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file,
      legacyRecord: cancel,
      selectedItemId: "att_cancel",
    });
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    await initializePanel(createPanelDependencies(controller, { localBridge }));
    localBridge.publish.mockClear();

    controller.__setSnapshot({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      selectedItemId: "att_cancel",
      legacyRecord: cancel,
    });
    controller.__setSnapshot({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/account" },
      selectedItemId: "att_account",
      legacyRecord: account,
    });
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const payloads = localBridge.publish.mock.calls.map(([payload]) => payload);
    const accountPayload = payloads.find((payload) => (
      payload.page?.route === `${ORIGIN}/account`
    ));
    expect(accountPayload).toMatchObject({ attachmentCount: 1 });
    expect(accountPayload?.agentCopy).toContain('Target: button "Account"');
    expect(payloads.at(-1)).toBe(accountPayload);
  });

  test("coalesces every bridge publish entry point so the newest page stays final", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = `${ORIGIN}/account`;
    account.attachment.source.url = account.pageUrl;
    const file = createSessionFile([save, account]);
    const controller = createFakeController({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      file,
      legacyRecord: save,
      selectedItemId: "att_save",
    });
    let releaseSlowPublish!: (value: boolean) => void;
    const slowPublish = new Promise<boolean>((resolve) => { releaseSlowPublish = resolve; });
    const localBridge = {
      readStatus: vi.fn(async () => disconnectedBridgeStatus()),
      createConnectionRequest: vi.fn(async () => ({
        ...disconnectedBridgeStatus(),
        pending: true,
        approvalMode: "ask" as const,
        requestText: "request",
        expiresAt: "2026-07-17T04:32:00.000Z",
      })),
      refreshConnection: vi.fn(async () => disconnectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => disconnectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const clipboard = { writeText: vi.fn(async () => undefined) };
    await initializePanel(createPanelDependencies(controller, { localBridge, clipboard }));
    await flushMicrotasks();
    localBridge.publish.mockClear();
    localBridge.publish.mockImplementationOnce(() => slowPublish).mockResolvedValue(true);

    controller.__setSnapshot({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/settings" },
      selectedItemId: "att_save",
      legacyRecord: save,
    });
    await flushMicrotasks();
    expect(localBridge.publish).toHaveBeenCalledTimes(1);

    controller.__setSnapshot({
      activePage: { tabId: 7, frameId: 0, origin: ORIGIN, pathname: "/account" },
      selectedItemId: "att_account",
      legacyRecord: account,
    });
    query<HTMLButtonElement>("#local-bridge-request").click();
    await flushMicrotasks();
    releaseSlowPublish(true);
    await flushMicrotasks();
    await flushMicrotasks();

    const payloads = localBridge.publish.mock.calls.map(([payload]) => payload);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.page?.route).toBe(`${ORIGIN}/settings`);
    expect(payloads.at(-1)).toMatchObject({
      page: { route: `${ORIGIN}/account` },
      attachmentCount: 1,
    });
    expect(payloads.at(-1)?.agentCopy).toContain('Target: button "Account"');
    expect(clipboard.writeText).toHaveBeenCalledWith("request");
  });

  test("fails the whole bridge projection closed when page identity is unavailable", async () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const localBridge = {
      readStatus: vi.fn(async () => connectedBridgeStatus()),
      createConnectionRequest: vi.fn(),
      refreshConnection: vi.fn(async () => connectedBridgeStatus()),
      refreshConnectionAndPublish: vi.fn(async () => connectedBridgeStatus()),
      publish: vi.fn(async () => true),
      disconnect: vi.fn(async () => undefined),
    };
    const controller = createFakeController({
      activePage: null,
      file: createSessionFile([save]),
      legacyRecord: save,
      selectedItemId: "att_save",
    });

    await initializePanel(createPanelDependencies(controller, { localBridge }));
    await flushMicrotasks();

    expect(localBridge.publish.mock.calls.at(-1)?.[0]).toEqual({
      page: null,
      attachmentCount: 0,
      agentCopy: null,
    });
  });
});

type SnapshotOverrides = Partial<PanelSessionSnapshot> & {
  activeSupported?: boolean;
  clearPending?: boolean;
  sessionMutationPending?: boolean;
};

type TestPanelController = PanelSessionController & {
  __setSnapshot(next: SnapshotOverrides): void;
};

function createFakeController(overrides: SnapshotOverrides = {}): TestPanelController {
  let snapshot = createSnapshot(overrides);
  const listeners = new Set<(snapshot: PanelSessionSnapshot) => void>();
  const controller: TestPanelController = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      listener(structuredClone(snapshot));
      return () => listeners.delete(listener);
    }),
    initialize: vi.fn(async () => {
      emit();
    }),
    refreshActiveOrigin: vi.fn(async () => undefined),
    selectItem: vi.fn(async () => undefined),
    setIntent: vi.fn((intent) => {
      snapshot = { ...snapshot, intent, intentDirty: true };
      emit();
    }),
    flushIntent: vi.fn(async () => true),
    retryDirtyIntent: vi.fn(async () => undefined),
    discardDirtyIntent: vi.fn(async () => {
      snapshot = { ...snapshot, intentDirty: false };
      emit();
    }),
    removeItem: vi.fn(async () => undefined),
    clearSession: vi.fn(async () => undefined),
    readExport: vi.fn(async () => createExport(snapshot)),
    setViewMode: vi.fn((viewMode) => {
      snapshot = { ...snapshot, viewMode };
      emit();
    }),
    getSnapshot: vi.fn(() => structuredClone(snapshot)),
    __setSnapshot(next) {
      snapshot = {
        ...snapshot,
        ...next,
      };
      emit();
    },
  };
  function emit(): void {
    for (const listener of listeners) {
      listener(structuredClone(snapshot));
    }
  }
  return controller;
}

function createSnapshot(overrides: SnapshotOverrides): PanelSessionSnapshot {
  const file = createSessionFile([
    createCaptureRecord("save", "Save changes", "agent_safe"),
    createCaptureRecord("cancel", "Cancel", "full_debug"),
  ]);
  return {
    activeSupported: true,
    clearPending: false,
    sessionMutationPending: false,
    origin: ORIGIN,
    activePage: { tabId: 1, frameId: 0, origin: ORIGIN, pathname: "/settings" },
    epoch: "epoch-1",
    file,
    legacyRecord: file.session.attachments.at(-1)!.sourceRecord as OriginCaptureRecord,
    selectedItemId: "att_cancel",
    viewMode: "agent_safe",
    intent: "Update Cancel",
    intentDirty: false,
    status: { kind: "ready", message: "Capture session ready." },
    recovery: null,
    ...overrides,
  } as PanelSessionSnapshot;
}

function createExport(
  snapshot: PanelSessionSnapshot,
): SessionFileResult<{ file: NonNullable<PanelSessionSnapshot["file"]>; text: string; byteLength: number }> {
  return {
    ok: true,
    value: {
      file: snapshot.file!,
      text: `${JSON.stringify(snapshot.file, null, 2)}\n`,
      byteLength: 1,
    },
  };
}

function createPanelDependencies(
  controller: PanelSessionController,
  overrides: Partial<PanelDependencies> & {
    captureMode?: {
      read(): Promise<UIAttachmentDisclosureMode>;
    };
    testClickCapture?: {
      read(): Promise<boolean>;
      save(enabled: boolean): Promise<void>;
    };
    themePreference?: {
      read(): Promise<PanelThemePreference>;
    };
    previewCopy?: { read(): Promise<PreviewCopyPreference> };
    timeDisplay?: { read(): Promise<TimeDisplayPreference> };
    relationShortcuts?: { read(): Promise<RelationShortcutPreference[]> };
    frameScopeAutoStart?: { read(): Promise<boolean> };
    handoffFormatPreferences?: {
      read(): Promise<PanelHandoffFormatPreferences>;
      save(
        scope: "single" | "multi",
        format: PanelHandoffFormatPreferences["singleTarget"],
      ): Promise<void>;
    };
    addRuntimeMessageListener?(listener: (message: unknown) => void): void;
    addSettingsChangeListener?(listener: () => void): void;
    addWindowFocusListener?(listener: () => void): void;
    addWindowKeyDownListener?(listener: (event: KeyboardEvent) => void): void;
    addWindowBlurListener?(listener: () => void): void;
    addWindowPageHideListener?(listener: () => void): void;
    firstCaptureDisclosure?: FirstCaptureDisclosureStore;
  } = {},
): PanelDependencies {
  return {
    controller,
    clipboard: { writeText: vi.fn(async () => undefined) },
    confirm: overrides.confirm ?? (() => true),
    randomUUID: overrides.randomUUID ?? (() => "operation-1"),
    createObjectURL: overrides.createObjectURL ?? (() => "blob:session"),
    revokeObjectURL: overrides.revokeObjectURL ?? vi.fn(),
    setTimeout: overrides.setTimeout ?? ((callback) => {
      callback();
      return 1;
    }),
    firstCaptureDisclosure: overrides.firstCaptureDisclosure ?? {
      isAcknowledged: async () => true,
      acknowledge: async () => undefined,
    },
    timeDisplay: overrides.timeDisplay ?? { read: async () => "utc" },
    relationShortcuts: overrides.relationShortcuts ?? { read: async () => [] },
    ...overrides,
  } as PanelDependencies;
}

function bridgeStepStates(): Array<string | undefined> {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-bridge-step]"),
    (step) => step.dataset.state,
  );
}

function disconnectedBridgeStatus() {
  return {
    connected: false,
    instanceId: null,
    pending: false,
    approvalMode: null,
    requestText: null,
    expiresAt: null,
  };
}

function connectedBridgeStatus() {
  return {
    connected: true,
    instanceId: "instance-0123456789ab",
    pending: false,
    approvalMode: null,
    requestText: null,
    expiresAt: null,
  };
}

function createPanelDom(): string {
  return `
    <main>
      <button id="open-settings" type="button">Settings</button>
      <strong id="current-content-mode">Agent-safe</strong>
      <select id="capture-mode">
        <option value="agent_safe">Agent-safe</option>
        <option value="developer_diagnostic">Developer diagnostic</option>
        <option value="full_debug">Full debug</option>
      </select>
      <input id="independent-view-mode" type="checkbox" role="switch" />
      <label id="view-mode-field" hidden>
        <select id="view-mode">
          <option value="agent_safe">Agent-safe</option>
          <option value="developer_diagnostic">Developer diagnostic</option>
          <option value="full_debug">Full debug</option>
        </select>
      </label>
      <select id="theme-preference">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <input id="automatic-page-access" type="checkbox" role="switch" />
      <p id="automatic-page-access-status" role="status"></p>
      <details id="capture-scope" hidden>
        <summary>
          <span>Capture scope</span>
          <span id="capture-scope-breadcrumb"></span>
        </summary>
        <div id="capture-scope-tree" role="tree"></div>
        <p id="capture-scope-help"></p>
      </details>
      <button id="element-selection-toggle" type="button" aria-pressed="false">Add elements</button>
      <button id="review-data-disclosure" type="button">Review data disclosure</button>
      <dialog
        id="first-capture-disclosure"
        aria-labelledby="first-capture-disclosure-heading"
        aria-describedby="first-capture-disclosure-intro"
      >
        <h2 id="first-capture-disclosure-heading">Before your first capture</h2>
        <p id="first-capture-disclosure-intro" data-i18n="first_capture_disclosure_intro">MeanThis creates references for elements you choose. Each reference may also include page and nearby context.</p>
        <p id="first-capture-disclosure-status" role="status" aria-live="polite"></p>
        <button id="acknowledge-first-capture" type="button" data-i18n="acknowledge_and_return">I understand — return to Add elements</button>
        <button id="dismiss-first-capture" type="button">Not now</button>
      </dialog>
      <ol id="local-bridge-steps">
        <li data-bridge-step="trust" data-state="upcoming"></li>
        <li data-bridge-step="request" data-state="upcoming"></li>
        <li data-bridge-step="approve" data-state="upcoming"></li>
        <li data-bridge-step="connected" data-state="upcoming"></li>
      </ol>
      <label id="local-bridge-trust-field">
        <select id="local-bridge-approval-mode">
          <option value="ask">Ask every time</option>
          <option value="browser_session">Trust this browser session</option>
        </select>
      </label>
      <p id="local-bridge-trust-help"></p>
      <button id="local-bridge-request" type="button">Create &amp; copy request</button>
      <button id="local-bridge-disconnect" type="button" hidden>Disconnect</button>
      <details id="local-bridge-details" hidden>
        <textarea id="local-bridge-request-text" readonly hidden></textarea>
        <p id="local-bridge-instance" hidden></p>
      </details>
      <p id="local-bridge-status">Not connected.</p>
      <span id="origin"></span>
      <p id="status" role="status" aria-live="polite"></p>
      <section id="page-access-recovery" hidden>
        <h2 id="page-access-recovery-heading"></h2>
        <p id="page-access-recovery-reason"></p>
        <ol>
          <li id="page-access-recovery-first-step"></li>
          <li>Select MeanThis in the browser toolbar.</li>
          <li>Select Add elements again.</li>
        </ol>
        <p class="page-access-recovery-limit">Keep this side panel open. After you select MeanThis in the toolbar, it refreshes automatically.</p>
      </section>
      <section id="empty-workflow" hidden>
        <ol>
          <li><strong>Add elements</strong> <span>Select Add elements, then click each page target.</span></li>
          <li><strong>Describe the change</strong> <span>Write the result you want.</span></li>
          <li><strong>Copy for agent</strong> <span>Review the selected labels, then copy the handoff.</span></li>
        </ol>
      </section>
      <section id="session">
        <h2 data-i18n="session">Selected elements</h2>
        <span id="session-count"></span>
        <div class="session-list-frame">
          <div id="session-list"></div>
        </div>
        <button id="clear-session" class="session-reset" type="button">Clear selected elements</button>
        <details id="advanced-session-tools" data-developer-tooling hidden>
          <summary>Advanced session tools</summary>
          <button id="export-session" type="button">Export source session</button>
        </details>
        <div id="intent-recovery" hidden>
          <button id="retry-intent" type="button">Retry save</button>
          <button id="discard-intent" type="button">Discard changes</button>
        </div>
      </section>
      <details id="saved-sites" hidden>
        <summary><span>Saved captures</span><span id="saved-sites-count">0</span></summary>
        <p>Review, reopen, restore, or clear saved captures.</p>
        <div id="saved-sites-list"></div>
        <button id="clear-all-saved-sites" class="utility-action destructive-action" type="button">Clear all saved captures</button>
        <p id="saved-sites-status" role="status" aria-live="polite"></p>
      </details>
      <section id="capture" hidden>
        <div id="capture-boundary" hidden>
          <strong id="capture-boundary-title"></strong>
          <p id="capture-boundary-message"></p>
        </div>
        <strong id="element-summary"></strong>
        <span id="locator-summary"></span>
        <dd id="captured-at"></dd>
        <dd id="redacted-fields"></dd>
        <dd id="sensitive-hints"></dd>
        <dd id="included-sensitive-fields"></dd>
        <p id="selected-target-summary" hidden></p>
        <details id="selected-target-details" hidden>
          <summary>Target details</summary>
          <dl>
            <div><dt>Selected element</dt><dd id="selected-target-full"></dd></div>
            <div><dt>Captured</dt><dd id="selected-target-captured-at"></dd></div>
            <div><dt>Source</dt><dd id="selected-target-source"></dd></div>
            <div id="selected-target-rebind-row" hidden>
              <dt>Current page</dt>
              <dd id="selected-target-rebind-status" class="session-rebind-status"></dd>
            </div>
          </dl>
        </details>
        <button id="remove-selected-item" type="button" data-i18n="remove_selected_element">Remove selected element</button>
        <textarea id="intent"></textarea>
        <p id="handoff-scope-summary"></p>
        <button id="copy-summary" type="button">Copy for agent</button>
        <div id="agent-handoff-copy-feedback" role="status" aria-live="polite" aria-atomic="true">
          <p id="agent-handoff-copy-status" hidden></p>
          <p id="agent-handoff-copy-next-step" hidden></p>
        </div>
        <details id="relation-settings" hidden>
          <summary>Task note shortcuts (optional)</summary>
          <div id="relation-composer" hidden>
            <p id="relation-role-summary" hidden></p>
            <select id="relation-action">
              <option value="below">Below</option>
              <option value="above">Above</option>
              <option value="left-of">Left of</option>
              <option value="right-of">Right of</option>
              <option value="align-left">Align left</option>
              <option value="match-width">Match width</option>
            </select>
            <select id="relation-reference"></select>
            <button id="apply-relation" type="button">Fill task note</button>
            <p id="relation-apply-status" hidden></p>
            <button id="change-generated-relation" type="button" hidden disabled>Change shortcut</button>
          </div>
        </details>
        <details id="optional-settings" hidden>
          <summary>Copy options</summary>
          <div id="handoff-options" hidden>
            <label id="handoff-format-field" for="handoff-format">
              <select id="handoff-format">
                <option value="exact">Full detail</option>
                <option value="compact">Compact</option>
              </select>
            </label>
            <details id="agent-handoff-preview">
              <summary id="agent-handoff-preview-heading">Preview copy content</summary>
              <textarea id="agent-handoff-text" readonly></textarea>
            </details>
          </div>
        </details>
        <details id="advanced-data" data-developer-tooling hidden>
          <summary>Developer diagnostics</summary>
          <p data-i18n="developer_diagnostics_help">Raw metadata and separate Markdown/JSON copies for debugging integrations.</p>
          <textarea id="agent-summary"></textarea>
          <textarea id="markdown"></textarea>
          <textarea id="json"></textarea>
          <button id="copy-markdown" type="button">Copy markdown</button>
          <button id="copy-json" type="button">Copy JSON</button>
        </details>
      </section>
    </main>
  `;
}

function storedOrigin(
  origin: string,
  epoch: string | null,
  attachmentCount: number | null,
): StoredOriginSessionSummary {
  return {
    origin,
    epoch,
    attachmentCount,
    state: epoch ? "ready" : "needs_cleanup",
    clearPending: false,
    activeClearOperationId: null,
  };
}

function storedReviewData() {
  return {
    origin: ORIGIN,
    epoch: "epoch-1",
    routes: [],
    items: [{
      label: "A",
      target: "button - Save changes",
      intent: "Keep it primary.",
      capturedAt: "2026-07-11T10:00:00.000Z",
      sourceDisclosureMode: "agent_safe" as const,
    }],
  };
}

function storedHandoffData(body: string) {
  const authority = {
    schemaVersion: "0.1.0" as const,
    kind: "ui-attach.saved-snapshot-authority" as const,
    status: "not_rechecked" as const,
    origin: ORIGIN,
    routingPolicy: "omitted" as const,
    evidencePolicy: "capture_time_observations_only" as const,
    controlPolicy: "live_recheck_and_user_confirmation_required" as const,
  };
  return {
    origin: ORIGIN,
    epoch: "epoch-1",
    format: "exact" as const,
    bundle: {
      kind: "ui-attach.saved-snapshot-prompt-bundle" as const,
      sessionId: "session-1",
      title: "Settings",
      disclosureMode: "agent_safe" as const,
      attachmentCount: 1,
      attachmentIds: ["att_save"],
      attachmentRefs: [{
        id: "att_save",
        label: "A",
        target: "button Save changes",
        role: "button",
        accessibleName: "Save changes",
        text: "Save changes",
        primaryLocator: 'page.getByRole("button", { name: "Save changes" })',
      }],
      authority,
      markdown: [
        "# MeanThis Saved Snapshot Bundle",
        "ui-attach.saved-snapshot-authority",
        "status: not_rechecked",
        body,
      ].join("\n"),
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function emptyReadback(origin: string) {
  return {
    origin,
    epoch: null,
    clearPending: false,
    activeClearOperationId: null,
    file: null,
    legacyRecord: null,
  };
}

function changeSelect(selector: string, value: UIAttachmentDisclosureMode): void {
  const select = query<HTMLSelectElement>(selector);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSwitch(selector: string, checked: boolean): void {
  const input = query<HTMLInputElement>(selector);
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelect(selector: string, value: string): void {
  const select = query<HTMLSelectElement>(selector);
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function query<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing test panel element: ${selector}`);
  }
  return found as T;
}

function queryOptional<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  const found = document.querySelector(selector);
  if (found === null) return null;
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing test panel element: ${selector}`);
  }
  return found as T;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255);
    if (!channels || channels.length !== 3) throw new Error("Invalid test color.");
    const [red, green, blue] = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
