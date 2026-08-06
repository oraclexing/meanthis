import { describe, expect, test } from "vitest";
import type { OriginCaptureRecord } from "./capture-store";
import {
  createCaptureRecord,
  createSessionFile,
} from "../test/session-fixtures";
import {
  derivePanelCopyScope,
  derivePanelSessionPreview,
  formatSessionItemCount,
  groupPanelSessionRows,
  getSourceExportWarning,
  requiresSourceExportConfirmation,
  selectInitialSessionItemId,
  summarizePanelSessionRows,
  summarizeSourceModes,
} from "./panel-session-model";

describe("panel session model", () => {
  test("summarizes rows in capture order with stable labels, source modes, and last item selected", () => {
    const file = createSessionFile([
      createCaptureRecord("save", "Save changes", "agent_safe"),
      createCaptureRecord("cancel", "Cancel", "full_debug"),
    ]);
    const selectedItemId = selectInitialSessionItemId(file);

    expect(selectedItemId).toBe("att_cancel");
    expect(summarizePanelSessionRows(file, selectedItemId, "agent_safe")).toEqual([
      {
        id: "att_save",
        label: "A",
        target: "button - Save changes",
        capturedAt: "2026-07-11T10:00:00.000Z",
        sourceDisclosureMode: "agent_safe",
        selected: false,
      },
      {
        id: "att_cancel",
        label: "B",
        target: "button - Cancel",
        capturedAt: "2026-07-11T10:02:00.000Z",
        sourceDisclosureMode: "full_debug",
        selected: true,
      },
    ]);
  });

  test("adds the shortest unique parent context only when displayed targets are duplicated", () => {
    const billing = createCaptureRecord("billing-save", "Save changes", "agent_safe");
    billing.attachment.context.parentSummary = "section Billing settings";
    const profile = createCaptureRecord("profile-save", "Save changes", "agent_safe");
    profile.attachment.context.parentSummary = "section Profile settings";
    const cancel = createCaptureRecord("cancel", "Cancel", "agent_safe");
    cancel.attachment.context.parentSummary = "section Profile settings";
    const file = createSessionFile([billing, profile, cancel]);

    expect(summarizePanelSessionRows(file, "att_profile-save", "agent_safe").map((row) => ({
      id: row.id,
      target: row.target,
    }))).toEqual([
      { id: "att_billing-save", target: "button - Save changes · Billing settings" },
      { id: "att_profile-save", target: "button - Save changes · Profile settings" },
      { id: "att_cancel", target: "button - Cancel" },
    ]);
  });

  test("falls back to unique nearby text and keeps unsafe source context out of agent-safe rows", () => {
    const billing = createCaptureRecord("billing-save", "Save changes", "full_debug");
    billing.attachment.context.parentSummary = "section";
    billing.attachment.context.nearbyText = ["Billing for ada@example.com"];
    const profile = createCaptureRecord("profile-save", "Save changes", "full_debug");
    profile.attachment.context.parentSummary = "section";
    profile.attachment.context.nearbyText = ["Profile for bob@example.com"];
    const file = createSessionFile([billing, profile]);

    const rows = summarizePanelSessionRows(file, "att_profile-save", "agent_safe");

    expect(rows.map((row) => row.target)).toEqual([
      "button - Save changes",
      "button - Save changes",
    ]);
    expect(JSON.stringify(rows)).not.toContain("ada@example.com");
    expect(JSON.stringify(rows)).not.toContain("bob@example.com");
  });

  test("does not use source context when disclosure derivation fails", () => {
    const billing = createCaptureRecord("billing-save", "Save changes", "agent_safe");
    billing.attachment.context.parentSummary = "section Billing ada@example.com";
    const profile = createCaptureRecord("profile-save", "Save changes", "agent_safe");
    profile.attachment.context.parentSummary = "section Profile bob@example.com";
    const file = createSessionFile([billing, profile]);

    const rows = summarizePanelSessionRows(file, null, "full_debug");

    expect(rows.map((row) => row.target)).toEqual([
      "button - Save changes",
      "button - Save changes",
    ]);
    expect(JSON.stringify(rows)).not.toContain("ada@example.com");
    expect(JSON.stringify(rows)).not.toContain("bob@example.com");
  });

  test("uses safe nearby text when duplicate parent context cannot distinguish targets", () => {
    const billing = createCaptureRecord("billing-save", "Save changes", "agent_safe");
    billing.attachment.context.parentSummary = "section";
    billing.attachment.context.nearbyText = ["Billing plan"];
    const profile = createCaptureRecord("profile-save", "Save changes", "agent_safe");
    profile.attachment.context.parentSummary = "section";
    profile.attachment.context.nearbyText = ["Profile details"];
    const file = createSessionFile([billing, profile]);

    expect(summarizePanelSessionRows(file, null, "agent_safe").map((row) => row.target)).toEqual([
      "button - Save changes · Billing plan",
      "button - Save changes · Profile details",
    ]);
  });

  test("disambiguates within the current page without letting another route block it", () => {
    const billing = { ...createCaptureRecord("billing-save", "Save changes"), tabId: 7, frameId: 0 };
    billing.attachment.context.parentSummary = "section Billing settings";
    const profile = { ...createCaptureRecord("profile-save", "Save changes"), tabId: 7, frameId: 0 };
    profile.attachment.context.parentSummary = "section Profile settings";
    const otherBilling = {
      ...createCaptureRecord("other-billing-save", "Save changes"),
      tabId: 7,
      frameId: 0,
      pageUrl: "https://app.example.test/billing",
    };
    otherBilling.attachment.context.parentSummary = "section Billing settings";
    const file = createSessionFile([billing, profile, otherBilling]);
    const activePage = {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/settings",
    };

    const rows = summarizePanelSessionRows(file, null, "agent_safe", activePage);
    const groups = groupPanelSessionRows(file, rows, activePage);

    expect(groups[0]?.rows.map((row) => row.target)).toEqual([
      "button - Save changes · Billing settings",
      "button - Save changes · Profile settings",
    ]);
    expect(groups[1]?.rows.map((row) => row.target)).toEqual([
      "button - Save changes",
    ]);
  });

  test("groups the active page first without exposing query or hash and selects its latest item", () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    save.pageUrl = "https://app.example.test/settings?token=secret#billing";
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = "https://app.example.test/account";
    const embedded = { ...createCaptureRecord("embedded", "Embedded"), tabId: 7, frameId: 2 };
    embedded.pageUrl = "https://app.example.test/embed";
    const otherTab = { ...createCaptureRecord("other", "Other tab"), tabId: 8, frameId: 0 };
    const file = createSessionFile([save, cancel, account, embedded, otherTab]);
    const activePage = {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/settings",
    };

    const selectedItemId = selectInitialSessionItemId(file, activePage);
    const rows = summarizePanelSessionRows(file, selectedItemId, "agent_safe");
    const groups = groupPanelSessionRows(file, rows, activePage);

    expect(selectedItemId).toBe("att_cancel");
    expect(groups.map((group) => ({
      current: group.current,
      label: group.label,
      rows: group.rows.map((row) => row.id),
    }))).toEqual([
      { current: true, label: "Current page · /settings", rows: ["att_save", "att_cancel"] },
      { current: false, label: "Other page · /account", rows: ["att_account"] },
      { current: false, label: "Embedded frame · /embed", rows: ["att_embedded"] },
      { current: false, label: "Other tab · /settings", rows: ["att_other"] },
    ]);
    expect(JSON.stringify(groups)).not.toContain("token=secret");
    expect(JSON.stringify(groups)).not.toContain("#billing");
  });

  test("derives a fail-closed copy scope from the selected page group", () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 0 };
    account.pageUrl = "https://app.example.test/account";
    const file = createSessionFile([save, cancel, account]);
    const activePage = {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/settings",
    };

    expect(derivePanelCopyScope(file, "att_cancel", activePage)).toEqual({
      key: "current",
      label: "Current page · /settings",
      itemIds: ["att_save", "att_cancel"],
      current: true,
    });
    expect(derivePanelCopyScope(file, "att_account", activePage)).toEqual({
      key: "page:/account",
      label: "Other page · /account",
      itemIds: ["att_account"],
      current: false,
    });
    expect(derivePanelCopyScope(file, "att_stale", activePage)).toBeNull();
    expect(derivePanelCopyScope(file, "att_cancel", null)).toBeNull();
  });

  test("treats rechecked route items as current without rewriting capture-time tab and frame ids", () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 3 };
    save.pageUrl = "https://app.example.test/embedded";
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 3 };
    cancel.pageUrl = "https://app.example.test/embedded";
    const account = { ...createCaptureRecord("account", "Account"), tabId: 7, frameId: 4 };
    account.pageUrl = "https://app.example.test/account";
    const file = createSessionFile([save, cancel, account]);
    const activePage = {
      tabId: 19,
      frameId: 6,
      origin: "https://app.example.test",
      pathname: "/embedded",
    };
    const liveCurrentItemIds = new Set(["att_save", "att_cancel"]);
    const rows = summarizePanelSessionRows(file, "att_cancel", "agent_safe", activePage);

    expect(groupPanelSessionRows(file, rows, activePage, liveCurrentItemIds).map((group) => ({
      current: group.current,
      rows: group.rows.map((row) => row.id),
    }))).toEqual([
      { current: true, rows: ["att_save", "att_cancel"] },
      { current: false, rows: ["att_account"] },
    ]);
    expect(derivePanelCopyScope(file, "att_cancel", activePage, liveCurrentItemIds)).toEqual({
      key: "current",
      label: "Current page · /embedded",
      itemIds: ["att_save", "att_cancel"],
      current: true,
    });
    expect(save.tabId).toBe(7);
    expect(save.frameId).toBe(3);
  });

  test("keeps failed rechecks out of current and copy scope at the original endpoint", () => {
    const save = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    const cancel = { ...createCaptureRecord("cancel", "Cancel"), tabId: 7, frameId: 0 };
    const file = createSessionFile([save, cancel]);
    const activePage = {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/settings",
    };
    const restored = new Set(["att_save"]);
    const excluded = new Set(["att_cancel"]);
    const rows = summarizePanelSessionRows(file, "att_save", "agent_safe", activePage);

    expect(groupPanelSessionRows(file, rows, activePage, restored, excluded).map((group) => ({
      current: group.current,
      rows: group.rows.map((row) => row.id),
    }))).toEqual([
      { current: true, rows: ["att_save"] },
      { current: false, rows: ["att_cancel"] },
    ]);
    expect(derivePanelCopyScope(file, "att_save", activePage, restored, excluded)?.itemIds).toEqual([
      "att_save",
    ]);
    expect(derivePanelCopyScope(file, "att_cancel", activePage, restored, excluded)).toBeNull();
  });

  test("treats a content target restored in another same-origin view as current", () => {
    const record = { ...createCaptureRecord("save", "Likes 10"), tabId: 7, frameId: 0 };
    record.pageUrl = "https://app.example.test/feed";
    const file = createSessionFile([record]);
    const activePage = {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/alice/status/1952521961831320123",
    };
    const restored = new Set(["att_save"]);
    const rows = summarizePanelSessionRows(file, "att_save", "agent_safe", activePage);

    expect(groupPanelSessionRows(file, rows, activePage, restored)[0]).toMatchObject({
      key: "current",
      label: "Current page · /alice/status/1952521961831320123",
      current: true,
    });
    expect(derivePanelCopyScope(file, "att_save", activePage, restored)).toMatchObject({
      key: "current",
      current: true,
      itemIds: ["att_save"],
    });
  });

  test("does not select a capture from another page when the active page has no targets", () => {
    const settings = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    settings.pageUrl = "https://app.example.test/settings";
    const file = createSessionFile([settings]);

    expect(selectInitialSessionItemId(file, {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/profile",
    })).toBeNull();
  });

  test.each([
    {
      name: "missing page URL",
      mutate: (record: OriginCaptureRecord) => { record.pageUrl = null; },
    },
    {
      name: "missing tab ID",
      mutate: (record: OriginCaptureRecord) => { delete record.tabId; },
    },
    {
      name: "missing frame ID",
      mutate: (record: OriginCaptureRecord) => { delete record.frameId; },
    },
  ])("fails copy scope closed for $name", ({ mutate }) => {
    const record = { ...createCaptureRecord("save", "Save changes"), tabId: 7, frameId: 0 };
    mutate(record);
    const file = createSessionFile([record]);

    expect(derivePanelCopyScope(file, "att_save", {
      tabId: 7,
      frameId: 0,
      origin: "https://app.example.test",
      pathname: "/settings",
    })).toBeNull();
  });

  test("reports disclosure counts, risky export warning, and 26 item count text", () => {
    const file = createSessionFile([
      createCaptureRecord("safe", "Safe", "agent_safe"),
      createCaptureRecord("debug", "Debug", "full_debug"),
    ]);
    const fullFile = createSessionFile(
      Array.from({ length: 26 }, (_unused, index) =>
        createCaptureRecord(`item-${index}`, `Item ${index + 1}`, "agent_safe"),
      ),
    );

    expect(summarizeSourceModes(file)).toEqual({
      agent_safe: 1,
      developer_diagnostic: 0,
      full_debug: 1,
    });
    expect(requiresSourceExportConfirmation(file)).toBe(true);
    expect(getSourceExportWarning(file)).toBe(
      "Export includes developer_diagnostic or full_debug source material. Review before sharing.",
    );
    expect(formatSessionItemCount(fullFile)).toBe("26/26 items");
  });

  test("keeps same-origin legacy preview but exposes no rows or export when no session exists", () => {
    const legacyRecord = createCaptureRecord("save", "Save changes", "full_debug");

    expect(summarizePanelSessionRows(null, null, "agent_safe")).toEqual([]);
    expect(requiresSourceExportConfirmation(null)).toBe(false);
    expect(derivePanelSessionPreview({
      file: null,
      legacyRecord,
      selectedItemId: null,
      viewMode: "agent_safe",
    })).toMatchObject({
      ok: true,
      record: {
        origin: legacyRecord.origin,
        attachment: { policy: { disclosureMode: "agent_safe" } },
      },
    });
  });

  test("derives view-only previews without mutating the stored source record", () => {
    const fullDebug = createCaptureRecord("save", "Save changes", "full_debug");
    fullDebug.attachment.context.nearbyText = ["Signed in as ada@example.com"];
    const fullFile = createSessionFile([fullDebug]);
    const safeFile = createSessionFile([
      createCaptureRecord("save", "Save changes", "agent_safe"),
    ]);

    const safePreview = derivePanelSessionPreview({
      file: fullFile,
      legacyRecord: null,
      selectedItemId: "att_save",
      viewMode: "agent_safe",
    });
    const deniedPreview = derivePanelSessionPreview({
      file: safeFile,
      legacyRecord: null,
      selectedItemId: "att_save",
      viewMode: "full_debug",
    });

    expect(safePreview).toMatchObject({
      ok: true,
      record: {
        attachment: {
          policy: { disclosureMode: "agent_safe" },
          context: { nearbyText: [] },
        },
      },
    });
    expect(JSON.stringify(safePreview)).not.toContain("ada@example.com");
    expect(deniedPreview).toMatchObject({
      ok: false,
      status: "Capture again with full_debug disclosure to include full debug details.",
    });
    expect(fullFile.session.attachments[0].sourceRecord.attachment.policy.disclosureMode).toBe(
      "full_debug",
    );
    expect(fullFile.session.attachments[0].sourceRecord.attachment.context.nearbyText).toEqual([
      "Signed in as ada@example.com",
    ]);
  });

  test("derives session row targets through the selected disclosure view", () => {
    const fullDebug = createCaptureRecord(
      "invite",
      "Invite ada@example.com",
      "full_debug",
    );
    const file = createSessionFile([fullDebug]);

    const rows = summarizePanelSessionRows(file, "att_invite", "agent_safe");

    expect(rows[0].target).toBe("button - Invite [redacted:email]");
    expect(JSON.stringify(rows)).not.toContain("ada@example.com");
    expect(fullDebug.attachment.element.accessibleName).toBe("Invite ada@example.com");
  });
});
