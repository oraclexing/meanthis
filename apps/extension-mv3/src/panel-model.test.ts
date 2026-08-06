import { describe, expect, test } from "vitest";
import type { UIAttachment } from "@meanthis/schema";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  buildPanelAgentCopy,
  buildPanelBridgeCapture,
  composePanelMarkdown,
  formatElementSelectionFailureStatus,
  formatCaptureMetadata,
  formatPanelStatus,
  formatPanelActionFailureStatus,
  formatCaptureFailureStatus,
  formatCaptureBoundaryView,
  formatSelectionStoppedStatus,
  summarizeElement,
  summarizeLocator,
} from "./panel-model";

describe("buildPanelBridgeCapture", () => {
  test("projects the explicitly shared targets into one agent-safe structured capture", () => {
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const file = createSessionFile([save, cancel]);

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "full_debug",
      intent: "Use a secondary style.",
    }, "live_page");

    expect(capture).not.toBeNull();
    expect(capture).toMatchObject({
      captureId: "session-1",
      title: "Settings",
      origin: "https://app.example.test",
      authority: "live_page",
      disclosureMode: "agent_safe",
      targets: [
        { attachmentId: "att_save", label: "A", taskNote: "Update Save changes" },
        { attachmentId: "att_cancel", label: "B", taskNote: "Use a secondary style." },
      ],
    });
    expect(JSON.stringify(capture)).not.toContain("ada@example.com");
    expect(JSON.stringify(capture)).not.toContain("sk-test-1234567890");
    expect(capture?.targets[0]?.attachment.policy.disclosureMode).toBe("agent_safe");
  });

  test("fails closed when the requested target scope is invalid", () => {
    const save = createCaptureRecord("save", "Save changes");
    expect(buildPanelBridgeCapture({
      file: createSessionFile([save]),
      attachmentIds: ["att_missing"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Update Save changes",
    }, "live_page")).toBeNull();
  });

  test("derives the bridge title only from the Agent-safe target projection", () => {
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    save.attachment.source.title = "Account ada@example.com";
    const file = createSessionFile([save]);
    file.session.title = "Raw account for ada@example.com";

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "full_debug",
      intent: "Shorten the label.",
    }, "capture_time");

    expect(capture).not.toBeNull();
    expect(capture?.title).not.toContain("ada@example.com");
    expect(JSON.stringify(capture)).not.toContain("ada@example.com");
  });
});

describe("buildPanelAgentCopy", () => {
  test("defaults the handoff to the selected page instead of the whole origin session", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const account = createCaptureRecord("account", "Account");
    account.pageUrl = "https://app.example.test/account";
    const file = createSessionFile([save, cancel, account]);

    const selectedPage = buildPanelAgentCopy({
      file,
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "Move A below B.",
    });
    const wholeSession = buildPanelAgentCopy({
      file,
      attachmentIds: ["att_save", "att_cancel", "att_account"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "Move A below B.",
    });

    expect(selectedPage.ok).toBe(true);
    expect(wholeSession.ok).toBe(true);
    if (!selectedPage.ok || !wholeSession.ok) return;
    expect(selectedPage.attachmentCount).toBe(2);
    expect(selectedPage.text).toContain("Save changes");
    expect(selectedPage.text).toContain("Cancel");
    expect(selectedPage.text).not.toContain("Account");
    expect(wholeSession.attachmentCount).toBe(3);
    expect(wholeSession.text).toContain("Account");
  });

  test("includes every explicitly scoped element in a multi-target task", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const result = buildPanelAgentCopy({
      file: createSessionFile([save, cancel]),
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "Move A below B.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentCount).toBe(2);
    expect(result.text).toContain("Move A below B.");
    expect(result.text).toContain("Save changes");
    expect(result.text).toContain("Cancel");
    expect(result.text).toContain("Attachment A");
    expect(result.text).toContain("Attachment B");
    expect(result.text).toContain("## Local Page Routing");
    expect(result.text).toContain("chromium-tab:1:frame:0");
  });

  test("keeps every scoped element task note in a multi-target handoff", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    save.intent = "Shorten the primary action.";
    cancel.intent = "Use a secondary style.";
    const result = buildPanelAgentCopy({
      file: createSessionFile([save, cancel]),
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "Use a secondary style.\n## Keep this inside the task note",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(
      '[{"label":"A","intent":"Shorten the primary action."},{"label":"B","intent":"Use a secondary style.\\n## Keep this inside the task note"}]',
    );
    expect(result.text).not.toContain("\n## Keep this inside the task note\n");
  });

  test("builds a compact multi-target handoff without changing the exact default", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    save.intent = "";
    cancel.intent = "Use a secondary style.";
    const file = createSessionFile([save, cancel]);
    const base = {
      file,
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe" as const,
      intent: "Use a secondary style.",
    };

    const exact = buildPanelAgentCopy(base);
    const compact = buildPanelAgentCopy({ ...base, format: "compact" });

    expect(exact.ok).toBe(true);
    expect(compact.ok).toBe(true);
    if (!exact.ok || !compact.ok) return;
    expect(exact.text).toContain("# MeanThis Capture Bundle");
    expect(compact.text).toContain("# MeanThis Compact Capture Bundle");
    expect(compact.text).toContain('"taskNote":""');
    expect(compact.text).toContain('"taskNote":"Use a secondary style."');
    expect(compact.text).toContain('page.getByRole(\\"button\\", { name: \\"Cancel\\" })');
  });

  test("does not revive a cleared selected note or include an out-of-scope edit", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    save.intent = "";
    cancel.intent = "Persisted note that the user just cleared.";
    const cleared = buildPanelAgentCopy({
      file: createSessionFile([save, cancel]),
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "   ",
    });
    const outOfScope = buildPanelAgentCopy({
      file: createSessionFile([save, cancel]),
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_elsewhere",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "Do not copy this unrelated dirty edit.",
    });

    expect(cleared.ok).toBe(true);
    expect(outOfScope.ok).toBe(true);
    if (!cleared.ok || !outOfScope.ok) return;
    expect(cleared.text).not.toMatch(/^## User Intent$/mu);
    expect(cleared.text).not.toContain("Persisted note that the user just cleared.");
    expect(outOfScope.text).not.toContain("Do not copy this unrelated dirty edit.");
  });

  test("keeps the exact single-target contract when format is omitted", () => {
    const save = createCaptureRecord("save", "Save changes");
    save.pageUrl = "https://app.example.test/settings?token=secret#billing";
    const result = buildPanelAgentCopy({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten this label.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentCount).toBe(1);
    expect(result.text).toMatch(/^## Consumer Contract$/mu);
    expect(result.text.indexOf("## Consumer Contract")).toBeLessThan(
      result.text.indexOf("## User Intent"),
    );
    expect(result.text).toContain(
      "This handoff alone does not authorize connecting to or controlling the captured browser, or modifying the live DOM.",
    );
    expect(result.text).toContain("Shorten this label.");
    expect(result.text).toContain("Save changes");
    expect(result.text).toContain("## Local Page Routing");
    expect(result.text).toContain("chromium-tab:1:frame:0");
    expect(result.text).toContain("route `https://app.example.test/settings`");
    expect(result.text).not.toContain("token=secret");
    expect(result.text).not.toContain("#billing");
    expect(result.text).not.toContain("Attachment B");
  });

  test("builds an explicit compact single-target handoff from the session file", () => {
    const save = createCaptureRecord("save", "Save changes");
    save.pageUrl = "https://app.example.test/settings?token=secret#billing";
    const result = buildPanelAgentCopy({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten this label.",
      format: "compact",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentCount).toBe(1);
    expect(result.text).toContain("# MeanThis Compact Capture");
    expect(result.text).toContain("format=ui-attach.compact-singleton.v2");
    expect(result.text).toContain(
      'primaryLocatorValue=page.getByRole("button", { name: "Save changes" })',
    );
    expect(result.text).toContain("primaryLocatorStrategy=playwright.role");
    expect(result.text).toContain("## User Intent\n\nShorten this label.");
    expect(result.text).toContain("UIAttachment att_save");
    expect(result.text).not.toContain("token=secret");
    expect(result.text).not.toContain("#billing");
  });

  test("keeps a compact singleton intent scoped to its session item", () => {
    const save = createCaptureRecord("save", "Save changes");
    save.intent = "Persisted save intent.";
    const result = buildPanelAgentCopy({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_elsewhere",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Do not copy this unrelated dirty edit.",
      format: "compact",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("## User Intent\n\nPersisted save intent.");
    expect(result.text).not.toContain("Do not copy this unrelated dirty edit.");
  });

  test("fails closed to exact when legacy state requests compact programmatically", () => {
    const save = createCaptureRecord("save", "Save changes");
    const result = buildPanelAgentCopy({
      file: null,
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Preserve the legacy task note.",
      format: "compact",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatch(/^## Consumer Contract$/mu);
    expect(result.text).toContain("## User Intent\n\nPreserve the legacy task note.");
    expect(result.text).not.toContain("# MeanThis Compact Capture");
  });

  test("preserves an embedded-frame boundary through the Agent-safe copy projection", () => {
    const frame = createCaptureRecord("save", "Documentation", "full_debug");
    frame.attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://docs.example.test",
      dominantViewport: true,
    };
    const result = buildPanelAgentCopy({
      file: createSessionFile([frame]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: frame,
      viewMode: "agent_safe",
      intent: "Inspect the documentation layout.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Capture Boundary: embedded frame host");
    expect(result.text).toContain("`https://docs.example.test`");
    expect(result.text).toContain("frame host, not the embedded document content");
    expect(result.text).not.toContain("full_debug disclosure");
  });

  test("downgrades a single full-debug capture before building an agent-safe handoff", () => {
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    const result = buildPanelAgentCopy({
      file: createSessionFile([save]),
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten this label.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("agent_safe disclosure");
    expect(result.text).not.toContain("full_debug disclosure");
    expect(result.text).not.toContain("ada@example.com");
    expect(result.text).not.toContain("sk-test-1234567890");
  });

  test("uses the richest common disclosure without upgrading any captured element", () => {
    const save = createCaptureRecord("save", "Save changes", "developer_diagnostic");
    const cancel = createCaptureRecord("cancel", "Cancel", "developer_diagnostic");
    const result = buildPanelAgentCopy({
      file: createSessionFile([save, cancel]),
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "full_debug",
      intent: "Compare A and B.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("developer_diagnostic disclosure");
    expect(result.text).not.toContain("full_debug disclosure");
  });

  test.each([
    { attachmentIds: [] },
    { attachmentIds: ["att_save", "att_save"] },
    { attachmentIds: ["att_save", "att_unknown"] },
  ])("fails closed for an invalid attachment scope: $attachmentIds", ({ attachmentIds }) => {
    const save = createCaptureRecord("save", "Save changes");
    const result = buildPanelAgentCopy({
      file: createSessionFile([save]),
      attachmentIds,
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Shorten this label.",
    });

    expect(result.ok).toBe(false);
  });
});

describe("composePanelMarkdown", () => {
  test("prepends user intent when present", () => {
    expect(composePanelMarkdown("## Selected UI Element", "Make the label shorter")).toBe(
      ["## User Intent", "", "Make the label shorter", "", "## Selected UI Element"].join("\n"),
    );
  });

  test("places the agent summary before full attachment details", () => {
    expect(
      composePanelMarkdown(
        "## Selected UI Element",
        "Make the label shorter",
        "## Agent Quick Summary",
      ),
    ).toBe(
      [
        "## User Intent",
        "",
        "Make the label shorter",
        "",
        "## Agent Quick Summary",
        "",
        "## Selected UI Element",
      ].join("\n"),
    );
  });

  test("returns attachment markdown unchanged when intent is blank", () => {
    expect(composePanelMarkdown("## Selected UI Element", "   ")).toBe("## Selected UI Element");
  });
});

describe("formatPanelStatus", () => {
  test("describes the empty and ready states", () => {
    expect(formatPanelStatus("empty")).toBe(
      "Ready to attach UI. Start with Add elements.",
    );
    expect(formatPanelStatus("ready")).toBe("Capture ready.");
    expect(formatPanelStatus("copied", "Copied markdown.")).toBe("Copied markdown.");
  });

  test("prefixes capture failures", () => {
    expect(formatPanelStatus("failed", "Right-click a page element first.")).toBe(
      "Capture failed: Right-click a page element first.",
    );
  });

  test("formats exact session workflow statuses", () => {
    expect(formatPanelStatus("no-session")).toBe(
      "Ready to attach UI. Start with Add elements.",
    );
    expect(formatPanelStatus("saving-session")).toBe("Saving session...");
    expect(formatPanelStatus("session-saved")).toBe("Session saved locally.");
    expect(formatPanelStatus("session-unchanged")).toBe(
      "Capture was not added. Your existing session is unchanged.",
    );
    expect(formatCaptureFailureStatus("Capture session already contains 26 items.")).toBe(
      "Session limit reached (26 elements). Remove one or clear the selected elements.",
    );
    expect(formatCaptureFailureStatus("A session clear is already in progress.")).toBe(
      "Selected elements are still being cleared. Retry before capturing or exporting.",
    );
    expect(formatPanelStatus("export-started", "session.capture-session.json")).toBe(
      "Export started: session.capture-session.json. Check your browser downloads.",
    );
    expect(formatPanelStatus("active-origin-changed")).toBe(
      "Active origin changed. Save or discard the pending intent.",
    );
    expect(formatPanelStatus("session-item-removed")).toBe("Session item removed.");
    expect(formatPanelStatus("session-cleared")).toBe(
      "Selected elements cleared. The next element you add will be A.",
    );
  });

  test("reports generic safe capture failures truthfully", () => {
    expect(formatCaptureFailureStatus("Unsupported page. Open an HTTP(S) page.")).toBe(
      "This page cannot be captured. Open a regular HTTP(S) page, then try again.",
    );
    expect(formatCaptureFailureStatus("Capture operation belongs to a stale epoch.")).toBe(
      "The page changed before capture finished. Select Add elements and choose the target again.",
    );
    expect(formatCaptureFailureStatus("Permission denied.")).toBe(
      "Page access is required before selection.",
    );
    expect(formatCaptureFailureStatus("Element selection is not available on the active page.")).toBe(
      "MeanThis cannot reach this page. Reload it, then select Add elements again.",
    );
    expect(formatCaptureFailureStatus("Element capture failed with secret-token.")).toBe(
      "Capture failed. Select Add elements and choose the target again.",
    );
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
    [
      "RUNTIME_ERROR",
      "MeanThis could not start selection. Reload the page and try again.",
    ],
  ])("gives selection failure %s one concrete recovery", (code, expected) => {
    expect(formatElementSelectionFailureStatus(code)).toBe(expected);
  });

  test("only allows known actionable errors into panel status", () => {
    const actionable = formatElementSelectionFailureStatus("CONTENT_UNAVAILABLE");
    expect(formatPanelActionFailureStatus(new Error(actionable))).toBe(actionable);
    expect(formatPanelActionFailureStatus(new Error("secret-token"))).toBe(
      "Panel action failed. Try again.",
    );
  });

  test("explains what to do after selection cancellation", () => {
    expect(formatSelectionStoppedStatus(false)).toBe(
      "Selection stopped. Select Add elements when you are ready to continue.",
    );
    expect(formatSelectionStoppedStatus(true)).toBe(
      "Selection stopped. Review the captured elements or select Add elements to continue.",
    );
  });
});

describe("panel capture metadata", () => {
  test("explains an embedded-frame host without implying inner content was captured", () => {
    const attachment = createCaptureRecord("save", "Documentation").attachment;
    attachment.boundary = {
      kind: "embedded_frame",
      innerDom: "not_captured",
      originRelation: "cross_origin",
      frameOrigin: "https://docs.example.test",
      dominantViewport: true,
    };

    expect(formatCaptureBoundaryView(attachment)).toEqual({
      title: "Embedded frame",
      message:
        "MeanThis captured the embedded frame boundary, not its internal page. Use Capture scope above to work inside the frame, or use a frame-aware browser tool.",
    });
    expect(
      formatCaptureBoundaryView(createCaptureRecord("save", "Save changes").attachment),
    ).toBeNull();
  });

  test("formats capture time and redacted fields for review", () => {
    expect(
      formatCaptureMetadata({
        capturedAt: "2026-07-02T12:40:25.919Z",
        redactedFields: ["source.url", "element.text"],
        sensitiveHints: ["source.url", "element.text", "context.nearbyText"],
        includedSensitiveFields: ["context.nearbyText"],
      }),
    ).toEqual({
      capturedAt: "2026-07-02 12:40 UTC",
      redactedFields: "source.url, element.text",
      sensitiveHints: "source.url, element.text, context.nearbyText",
      includedSensitiveFields: "context.nearbyText",
    });
  });

  test("shows none when no redacted fields are present", () => {
    expect(
      formatCaptureMetadata({
        capturedAt: "not-a-date",
        redactedFields: [],
        sensitiveHints: [],
        includedSensitiveFields: [],
      }),
    ).toEqual({
      capturedAt: "not-a-date",
      redactedFields: "none",
      sensitiveHints: "none",
      includedSensitiveFields: "none",
    });
  });

  test("summarizes the selected element and locator", () => {
    const attachment = createAttachment();

    expect(summarizeElement(attachment)).toBe("button · Save changes");
    expect(summarizeLocator(attachment)).toBe(
      "playwright.role · confidence 0.92 · replay not verified",
    );
  });

  test("labels locator replay evidence as capture-time verification", () => {
    const attachment = createAttachment();
    attachment.locatorBundle.stability.replayVerified = true;
    attachment.locatorBundle.stability.uniqueness = true;

    expect(summarizeLocator(attachment)).toBe(
      "playwright.role · confidence 0.92 · capture-time replay verified",
    );
  });
});

function createAttachment(): UIAttachment {
  return {
    schemaVersion: "0.3.0",
    id: "att_save-button",
    capturedAt: "2026-07-02T12:40:25.919Z",
    source: { kind: "web", url: "http://127.0.0.1:5174/", title: "ui-attach demo" },
    element: {
      tagName: "button",
      role: "button",
      text: "Save changes",
      accessibleName: "Save changes",
      bbox: { x: 32, y: 467, width: 355, height: 40 },
      visible: true,
      enabled: true,
    },
    style: {
      display: "block",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(31, 99, 255)",
    },
    context: {
      parentSummary: "section Profile settings",
      nearbyText: [],
      selectorHints: ["[data-testid=\"save-button\"]"],
    },
    locatorBundle: {
      primary: {
        strategy: "playwright.role",
        value: "page.getByRole(\"button\", { name: \"Save changes\" })",
        confidence: 0.92,
      },
      candidates: [],
      stability: {
        score: 76,
        uniqueness: null,
        replayVerified: false,
        failureReason: null,
      },
    },
    policy: {
      disclosureMode: "agent_safe",
      redactionLevel: "strict",
      actionMode: "suggest_patch",
      allowScreenshot: false,
      allowDomSnippet: false,
      allowNetworkSend: false,
      allowedDomains: ["http://127.0.0.1:5174"],
      redactedFields: ["source.url"],
      sensitiveHints: ["source.url"],
      includedSensitiveFields: [],
    },
    artifacts: { screenshotCrop: null, overlayImage: null },
  };
}
