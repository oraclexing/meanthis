import { describe, expect, test } from "vitest";
import {
  hydrateCaptureSessionFile,
  type CaptureSessionFileV2,
  type CaptureSessionFileV3,
} from "@meanthis/hub-core";
import {
  UI_ATTACHMENT_COMPUTED_STYLE_FIELDS,
  UI_ATTACH_LOCAL_BRIDGE_MAX_AGENT_COPY_BYTES,
  UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES,
  isLocalBridgeSnapshot,
  isUIAttachment,
  type MetadataDiagnosticsV1,
  type UIAttachment,
} from "@meanthis/schema";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import {
  buildPanelAgentCopy,
  buildPanelBridgeAgentCopy,
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
    Object.assign(save.attachment.style, {
      position: "relative",
      padding: "6px 8px",
      fontSize: "14px",
    });
    save.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.75,
    };
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
        {
          targetId: "target_A",
          attachmentId: "att_save",
          label: "A",
          taskNote: "Update Save changes",
        },
        {
          targetId: "target_B",
          attachmentId: "att_cancel",
          label: "B",
          taskNote: "Use a secondary style.",
        },
      ],
    });
    expect(JSON.stringify(capture)).not.toContain("ada@example.com");
    expect(JSON.stringify(capture)).not.toContain("sk-test-1234567890");
    expect(capture?.targets[0]?.attachment.policy.disclosureMode).toBe("agent_safe");
    expect(capture?.targets[0]?.attachment.selectionPoint).toEqual(
      save.attachment.selectionPoint,
    );
    expect(capture?.targets[0]?.attachment.style).toMatchObject({
      display: "block",
      position: "relative",
      padding: "6px 8px",
      fontSize: "14px",
    });
    expect(capture).not.toHaveProperty("metadataDiagnostics");
    expect(capture?.targets.map((target) => ({
      annotationId: target.annotationId,
      annotationIdScope: target.annotationIdScope,
      annotationCreatedAt: target.annotationCreatedAt,
      annotationUpdatedAt: target.annotationUpdatedAt,
    }))).toEqual([
      {
        annotationId: null,
        annotationIdScope: "unknown",
        annotationCreatedAt: null,
        annotationUpdatedAt: null,
      },
      {
        annotationId: null,
        annotationIdScope: "unknown",
        annotationCreatedAt: null,
        annotationUpdatedAt: null,
      },
    ]);
  });

  test("projects selected canonical replay facts as a bounded capture-time diagnostics sidecar", () => {
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    save.replayAttempts = [{
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Save changes" })',
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount: 1,
      visible: true,
    }];
    const cancel = createCaptureRecord("cancel", "Cancel", "full_debug");
    cancel.replayAttempts = [{
      strategy: "css",
      value: "[data-secret='never-publish']",
      replayVerified: false,
      uniqueness: false,
      failureReason: "locator matched 2 elements",
      matchCount: 2,
      visible: null,
    }];
    const file = createSessionFile([save, cancel]);

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Inspect replay stability.",
      includeReplayDiagnostics: true,
    }, "live_page");

    expect(capture?.metadataDiagnostics).toEqual({
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId: "session-1",
      scope: "capture",
      observedAt: file.session.updatedAt,
      consent: "explicit_capture",
      authority: "capture_time",
      replay: {
        status: "collected",
        attemptCount: 2,
        verifiedCount: 1,
        ambiguousCount: 1,
        missingCount: 0,
      },
      device: { status: "not_requested" },
      network: { status: "not_requested" },
      console: { status: "not_requested" },
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    });
    expect(JSON.stringify(capture?.metadataDiagnostics)).not.toContain("never-publish");
    expect(JSON.stringify(capture?.metadataDiagnostics)).not.toContain("locator matched");
  });

  test("merges supplied coarse device facts with the current-scope replay aggregate and fails closed on mismatches", () => {
    const currentSave = createCaptureRecord("save", "Save changes");
    currentSave.replayAttempts = [{
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Save changes" })',
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount: 1,
      visible: true,
    }];
    const currentCancel = createCaptureRecord("cancel", "Cancel");
    currentCancel.replayAttempts = [{
      strategy: "css",
      value: '[data-testid="cancel"]',
      replayVerified: false,
      uniqueness: false,
      failureReason: "multiple matches",
      matchCount: 2,
      visible: null,
    }];
    const outsideScope = createCaptureRecord("outside", "Outside scope");
    outsideScope.replayAttempts = [{
      strategy: "css",
      value: '[data-testid="outside"]',
      replayVerified: false,
      uniqueness: false,
      failureReason: "not found",
      matchCount: 0,
      visible: null,
    }];
    const file = createSessionFile([currentSave, currentCancel, outsideScope]);
    const supplied: MetadataDiagnosticsV1 = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId: file.session.id,
      scope: "capture",
      observedAt: "2026-07-11T10:01:00.000Z",
      consent: "explicit_capture",
      authority: "capture_time",
      replay: { status: "not_available" },
      device: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "large",
        touch: "coarse",
      },
      network: { status: "not_requested" },
      console: { status: "not_requested" },
      executionAuthority: {
        grantedByCapture: false,
        browserControl: false,
        liveDomMutation: false,
      },
    };
    const input = {
      file,
      // Exclude the third record to prove the aggregate is scoped to the
      // explicitly selected current capture targets.
      attachmentIds: [currentSave.attachment.id, currentCancel.attachment.id],
      selectedItemId: currentSave.attachment.id,
      selectedRecord: currentSave,
      viewMode: "agent_safe" as const,
      intent: currentSave.intent,
      includeReplayDiagnostics: true as const,
      metadataDiagnostics: supplied,
    };

    const capture = buildPanelBridgeCapture(input, "capture_time");
    expect(capture).toMatchObject({
      captureId: file.session.id,
      updatedAt: file.session.updatedAt,
      metadataDiagnostics: {
        observedAt: supplied.observedAt,
        replay: {
          status: "collected",
          attemptCount: 2,
          verifiedCount: 1,
          ambiguousCount: 1,
          missingCount: 0,
        },
        device: supplied.device,
        network: { status: "not_requested" },
        console: { status: "not_requested" },
      },
    });
    expect(capture?.metadataDiagnostics).not.toHaveProperty("viewportWidth");
    expect(capture?.metadataDiagnostics).not.toHaveProperty("userAgent");
    expect(capture?.metadataDiagnostics).not.toHaveProperty("url");
    expect(capture?.metadataDiagnostics).not.toHaveProperty("path");

    const malformedDevice = {
      ...supplied,
      device: {
        status: "collected",
        deviceClass: "desktop",
        viewportClass: "wide",
        touch: "coarse",
      },
    } as unknown as MetadataDiagnosticsV1;
    for (const metadataDiagnostics of [
      { ...supplied, captureId: "session-other" },
      { ...supplied, authority: "live_page" as const },
      {
        ...supplied,
        network: { status: "collected", requestCount: 1, failureCount: 0, windowMs: 10 },
      },
      {
        ...supplied,
        console: { status: "collected", logCount: 1, warnCount: 0, errorCount: 0, windowMs: 10 },
      },
      malformedDevice,
      { ...supplied, observedAt: "2026-07-11T10:02:00.001Z" },
    ]) {
      expect(buildPanelBridgeCapture({ ...input, metadataDiagnostics }, "capture_time"))
        .toBeNull();
    }
  });

  test("projects canonical V2 item identity and timestamps without deriving fallbacks", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    const file = createSessionFile([save, cancel]) as unknown as CaptureSessionFileV2;
    file.schemaVersion = "0.2.0";
    file.session.updatedAt = "2026-07-11T10:03:00.000Z";
    file.session.attachments = file.session.attachments.map((item, index) => ({
      ...item,
      annotationId: index === 0 ? "annotation-save" : "annotation-cancel",
      updatedAt: index === 0
        ? "2026-07-11T10:01:00.000Z"
        : "2026-07-11T10:02:00.000Z",
    }));

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe",
      intent: "Use a secondary style.",
    }, "capture_time");

    expect(capture?.targets.map((target) => ({
      annotationId: target.annotationId,
      annotationIdScope: target.annotationIdScope,
      annotationCreatedAt: target.annotationCreatedAt,
      annotationUpdatedAt: target.annotationUpdatedAt,
    }))).toEqual([
      {
        annotationId: "annotation-save",
        annotationIdScope: "capture_session",
        annotationCreatedAt: "2026-07-11T10:00:00.000Z",
        annotationUpdatedAt: "2026-07-11T10:01:00.000Z",
      },
      {
        annotationId: "annotation-cancel",
        annotationIdScope: "capture_session",
        annotationCreatedAt: "2026-07-11T10:02:00.000Z",
        annotationUpdatedAt: "2026-07-11T10:02:00.000Z",
      },
    ]);
  });

  test("preserves the complete identity group when compacting a V2 bridge target", () => {
    const save = createCaptureRecord("save", "Save changes");
    save.attachment.element.text = "large text ".repeat(30_000);
    save.attachment.element.accessibleName = "large accessible name ".repeat(30_000);
    const file = createSessionFile([save]) as unknown as CaptureSessionFileV2;
    file.schemaVersion = "0.2.0";
    file.session.updatedAt = "2026-07-11T10:01:00.000Z";
    file.session.attachments = file.session.attachments.map((item) => ({
      ...item,
      annotationId: "annotation-save",
      updatedAt: "2026-07-11T10:01:00.000Z",
    }));

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Keep the target compact.",
    }, "capture_time");

    expect(capture).not.toBeNull();
    expect(capture?.targets[0]).toMatchObject({
      annotationId: "annotation-save",
      annotationIdScope: "capture_session",
      annotationCreatedAt: "2026-07-11T10:00:00.000Z",
      annotationUpdatedAt: "2026-07-11T10:01:00.000Z",
    });
    expect(JSON.stringify(capture)).not.toContain("large accessible name ".repeat(30_000));
  });

  test("fails closed instead of downgrading a malformed declared V2 identity", () => {
    const save = createCaptureRecord("save", "Save changes");
    const file = createSessionFile([save]) as unknown as CaptureSessionFileV2;
    file.schemaVersion = "0.2.0";
    file.session.updatedAt = "2026-07-11T10:01:00.000Z";
    file.session.attachments = file.session.attachments.map((item) => ({
      ...item,
      annotationId: "annotation-save",
      updatedAt: "2026-07-11T10:01:00.000Z",
    }));
    delete (file.session.attachments[0] as Partial<
      CaptureSessionFileV2["session"]["attachments"][number]
    >).annotationId;

    expect(buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: "Keep this identity stable.",
    }, "capture_time")).toBeNull();
  });

  test("projects the exact V3 annotation lifecycle, keeps it during compaction, and rejects malformed input", () => {
    const save = createCaptureRecord("save", "Save changes");
    save.attachment.element.text = "large text ".repeat(30_000);
    const file = createSessionFile([save]) as unknown as CaptureSessionFileV3;
    file.schemaVersion = "0.3.0";
    file.session.updatedAt = "2026-07-11T10:03:00.000Z";
    file.session.attachments = file.session.attachments.map((item) => ({
      ...item,
      annotationId: "annotation-save",
      updatedAt: "2026-07-11T10:02:00.000Z",
      annotationLifecycle: {
        state: "resolved" as const,
        resolvedAt: "2026-07-11T10:01:00.000Z",
      },
    }));

    const input = {
      file,
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe" as const,
      intent: "Keep this lifecycle.",
    };
    const capture = buildPanelBridgeCapture(input, "capture_time");
    expect(capture).toMatchObject({
      annotationLifecycleVersion: "v1",
      targets: [{
        annotationId: "annotation-save",
        annotationLifecycle: {
          state: "resolved",
          resolvedAt: "2026-07-11T10:01:00.000Z",
        },
      }],
    });
    expect(isLocalBridgeSnapshot({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-11T10:03:00.000Z",
      page: null,
      attachmentCount: 1,
      agentCopy: null,
      capture,
    })).toBe(true);

    const missing = structuredClone(file);
    delete (missing.session.attachments[0] as unknown as Record<string, unknown>)
      .annotationLifecycle;
    const ownUndefined = structuredClone(file);
    (ownUndefined.session.attachments[0] as unknown as Record<string, unknown>)
      .annotationLifecycle = undefined;
    const extra = structuredClone(file);
    Object.assign(
      (extra.session.attachments[0] as unknown as Record<string, unknown>).annotationLifecycle as object,
      { extra: true },
    );
    const outOfOrder = structuredClone(file);
    (outOfOrder.session.attachments[0] as unknown as { annotationLifecycle: { resolvedAt: string } })
      .annotationLifecycle.resolvedAt = "2026-07-11T10:02:30.000Z";
    for (const invalid of [missing, ownUndefined, extra, outOfOrder]) {
      expect(buildPanelBridgeCapture({ ...input, file: invalid }, "capture_time")).toBeNull();
    }
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

  test("bounds long multibyte display labels without changing the source attachment", () => {
    const save = createCaptureRecord("save", "Save changes");
    const longTitle = `页面标题 ${"动态中文标题".repeat(80)}`;
    const longIntent = `任务说明 ${"保留完整上下文".repeat(1_000)}`;
    save.attachment.source.title = longTitle;
    const file = createSessionFile([save]);
    const longLabel = `A · span · ${"一段会持续变化的中文页面元素".repeat(12)}`;
    file.session.attachments[0]!.labels = [longLabel];

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: ["att_save"],
      selectedItemId: "att_save",
      selectedRecord: save,
      viewMode: "agent_safe",
      intent: longIntent,
    }, "live_page");

    const label = capture?.targets[0]?.label ?? "";
    expect(new TextEncoder().encode(label).byteLength).toBeLessThanOrEqual(128);
    expect(label).toMatch(/…$/u);
    expect(new TextEncoder().encode(capture?.title ?? "").byteLength).toBeLessThanOrEqual(512);
    expect(capture?.title).toMatch(/…$/u);
    expect(new TextEncoder().encode(capture?.targets[0]?.taskNote ?? "").byteLength)
      .toBeLessThanOrEqual(16_384);
    expect(capture?.targets[0]?.taskNote).toMatch(/…$/u);
    expect(file.session.attachments[0]!.labels[0]).toBe(longLabel);
    expect(capture?.targets[0]?.attachment.id).toBe(save.attachment.id);
    expect(JSON.stringify(capture?.targets[0]?.attachment)).toContain("Save changes");
    expect(capture?.targets[0]?.attachment.source.title).toBe(longTitle);
    expect(isLocalBridgeSnapshot({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-11T12:34:56.789Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 1,
      agentCopy: "Target details remain available.",
      capture,
      observations: {
        observedAt: "2026-07-11T12:34:56.789Z",
        documentInstanceId: "document-01234567",
        targets: [{ attachmentId: "att_save", status: "restored" }],
      },
    })).toBe(true);
  });

  test("keeps several individually valid text-heavy targets within the bridge capture budget", () => {
    const records = ["first", "second", "third"].map((seed) => {
      const record = createCaptureRecord(seed, `${seed} article`);
      record.attachment.element.text = "动态正文 ".repeat(3_500);
      record.attachment.element.accessibleName = "动态正文 ".repeat(3_500);
      record.attachment.element.contentParts = [{
        kind: "text",
        tagName: "p",
        role: null,
        text: "结构化正文".repeat(800),
        accessibleName: null,
      }];
      record.attachment.policy = {
        ...record.attachment.policy,
        redactedFields: ["element.text"],
        sensitiveHints: ["element.text", "element.accessibleName"],
        includedSensitiveFields: ["element.accessibleName"],
      };
      for (const key of UI_ATTACHMENT_COMPUTED_STYLE_FIELDS) {
        record.attachment.style[key] = `${seed}-${key}`;
      }
      return record;
    });
    const file = createSessionFile(records);
    expect(records.every((record) => isUIAttachment(record.attachment))).toBe(true);
    expect(hydrateCaptureSessionFile(file)).toMatchObject({ ok: true });

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: records.map((record) => record.attachment.id),
      selectedItemId: records[2]!.attachment.id,
      selectedRecord: records[2]!,
      viewMode: "agent_safe",
      intent: "Compare the three targets.",
    }, "capture_time");

    expect(capture?.targets).toHaveLength(3);
    expect(capture?.targets.map((target) => target.attachmentId)).toEqual(
      records.map((record) => record.attachment.id),
    );
    expect(capture?.targets[0]?.attachment.element.text).not.toBe(
      records[0]!.attachment.element.text,
    );
    expect(new TextEncoder().encode(JSON.stringify(capture)).byteLength)
      .toBeLessThanOrEqual(UI_ATTACH_LOCAL_BRIDGE_MAX_CAPTURE_BYTES);
    expect(capture?.targets.every((target) =>
      (target.attachment.element.contentParts?.length ?? 0) > 0
    )).toBe(true);
    for (const [index, target] of (capture?.targets ?? []).entries()) {
      expect(target.attachment.style).toEqual(records[index]!.attachment.style);
      expect(target.attachment.policy.redactedFields).toEqual(["element.text"]);
      expect(new Set(target.attachment.policy.sensitiveHints)).toEqual(
        new Set(["element.text", "element.accessibleName"]),
      );
      expect(target.attachment.policy.includedSensitiveFields).toEqual([
        "element.accessibleName",
      ]);
    }
    const handoff = buildPanelBridgeAgentCopy({
      file,
      attachmentIds: records.map((record) => record.attachment.id),
      selectedItemId: records[2]!.attachment.id,
      selectedRecord: records[2]!,
      viewMode: "agent_safe",
      intent: "Compare the three targets.",
    });
    expect(handoff.ok).toBe(false);
    expect(isLocalBridgeSnapshot({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-11T12:34:56.789Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 3,
      agentCopy: "Three compact targets are available through the structured capture.",
      capture,
    })).toBe(true);
  });

  test("fails closed when exact target styles alone cannot fit the bridge capture budget", () => {
    const maximumStyleValue = "界".repeat(170);
    const records = Array.from({ length: 26 }, (_, index) => {
      const record = createCaptureRecord(`style-${index + 1}`, `Target ${index + 1}`);
      record.attachment.style.display = maximumStyleValue;
      record.attachment.style.color = maximumStyleValue;
      record.attachment.style.backgroundColor = maximumStyleValue;
      for (const key of UI_ATTACHMENT_COMPUTED_STYLE_FIELDS) {
        record.attachment.style[key] = maximumStyleValue;
      }
      return record;
    });
    const file = createSessionFile(records);
    expect(records.every((record) => isUIAttachment(record.attachment))).toBe(true);
    expect(hydrateCaptureSessionFile(file)).toMatchObject({ ok: true });

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds: records.map((record) => record.attachment.id),
      selectedItemId: records[0]!.attachment.id,
      selectedRecord: records[0]!,
      viewMode: "agent_safe",
      intent: "Compare all targets without dropping their captured style facts.",
    }, "capture_time");

    expect(capture).toBeNull();
  });

  test("normalizes duplicate source attachment ids to the session item ids shared with the Agent", () => {
    const records = ["first", "second", "third"].map((seed) => {
      const record = createCaptureRecord(seed, `${seed} article`);
      record.attachment.id = "att_tweet";
      return record;
    });
    const file = createSessionFile(records);
    file.session.attachments.forEach((item, index) => {
      item.id = index === 0 ? "att_tweet" : `att_tweet-${index + 1}`;
    });
    const attachmentIds = file.session.attachments.map((item) => item.id);
    expect(hydrateCaptureSessionFile(file)).toMatchObject({ ok: true });

    const capture = buildPanelBridgeCapture({
      file,
      attachmentIds,
      selectedItemId: "att_tweet-3",
      selectedRecord: records[2]!,
      viewMode: "agent_safe",
      intent: "Compare the three targets.",
    }, "capture_time");

    expect(capture?.targets.map((target) => ({
      attachmentId: target.attachmentId,
      nestedAttachmentId: target.attachment.id,
    }))).toEqual(attachmentIds.map((attachmentId) => ({
      attachmentId,
      nestedAttachmentId: attachmentId,
    })));
    expect(isLocalBridgeSnapshot({
      schemaVersion: "0.1.0",
      kind: "ui-attach.local-bridge-snapshot",
      sequence: 1,
      publishedAt: "2026-07-11T12:34:56.789Z",
      page: {
        pageInstanceId: "chromium-tab:7:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 3,
      agentCopy: null,
      capture,
    })).toBe(true);
    expect(records.map((record) => record.attachment.id)).toEqual([
      "att_tweet",
      "att_tweet",
      "att_tweet",
    ]);
  });
});

describe("buildPanelAgentCopy", () => {
  test.each(["compact", "standard", "detailed", "forensic"] as const)(
    "%s feedback preserves scoped annotation numbers and resolved/reopened lifecycle",
    (outputDetail) => {
      const first = createCaptureRecord("save", "Save changes");
      const second = createCaptureRecord("cancel", "Cancel");
      const file = createSessionFile([first, second]) as unknown as CaptureSessionFileV3;
      file.schemaVersion = "0.3.0";
      file.session.updatedAt = "2026-07-11T10:04:00.000Z";
      file.session.attachments = file.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `annotation-${index + 1}`,
        updatedAt: "2026-07-11T10:03:00.000Z",
        annotationLifecycle: { state: "resolved" as const, resolvedAt: "2026-07-11T10:03:00.000Z" },
      }));
      const input = {
        file, attachmentIds: ["att_cancel"], selectedItemId: "att_cancel", selectedRecord: second,
        viewMode: "agent_safe" as const, intent: second.intent, outputDetail,
      };
      const resolved = buildPanelAgentCopy(input);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.text).toContain("Target B");
      expect(resolved.text).toContain("Annotation reference: 2");
      expect(resolved.text).toContain("Annotation lifecycle: resolved; resolvedAt=2026-07-11T10:03:00.000Z");
      expect(buildPanelBridgeCapture(input, "capture_time")?.targets[0]?.annotationLifecycle?.state).toBe("resolved");
      file.session.attachments[1]!.annotationLifecycle = { state: "open", resolvedAt: null };
      const reopened = buildPanelAgentCopy(input);
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) return;
      expect(reopened.text).toContain("Annotation lifecycle: open; resolvedAt=null");
      expect(reopened.text).not.toContain("lifecycle: resolved");
      expect(reopened.text).toContain(second.intent);
    },
  );

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
    const bridge = buildPanelBridgeAgentCopy(base);

    expect(exact.ok).toBe(true);
    expect(compact.ok).toBe(true);
    expect(bridge.ok).toBe(true);
    if (!exact.ok || !compact.ok || !bridge.ok) return;
    expect(exact.text).toContain("# MeanThis Capture Bundle");
    expect(compact.text).toContain("# MeanThis Compact Capture Bundle");
    expect(bridge.text).toBe(exact.text);
    expect(new TextEncoder().encode(bridge.text).byteLength)
      .toBeLessThanOrEqual(UI_ATTACH_LOCAL_BRIDGE_MAX_AGENT_COPY_BYTES);
    expect(compact.text).toContain('"taskNote":""');
    expect(compact.text).toContain('"taskNote":"Use a secondary style."');
    expect(compact.text).toContain('page.getByRole(\\"button\\", { name: \\"Cancel\\" })');
  });

  test("uses one four-level feedback serializer for single and multi-target widget copies", () => {
    const save = createCaptureRecord("save", "Save changes");
    const cancel = createCaptureRecord("cancel", "Cancel");
    save.intent = "Move this action below the profile form.";
    cancel.intent = "Use the secondary style.";
    const base = {
      file: createSessionFile([save, cancel]),
      attachmentIds: ["att_save", "att_cancel"],
      selectedItemId: "att_cancel",
      selectedRecord: cancel,
      viewMode: "agent_safe" as const,
      intent: "Use the secondary style.",
    };

    const compact = buildPanelAgentCopy({ ...base, outputDetail: "compact" });
    const forensic = buildPanelAgentCopy({ ...base, outputDetail: "forensic" });

    expect(compact.ok).toBe(true);
    expect(forensic.ok).toBe(true);
    if (!compact.ok || !forensic.ok) return;
    expect(compact.attachmentCount).toBe(2);
    expect(compact.text).toContain("Target A");
    expect(compact.text).toContain("Move this action below the profile form.");
    expect(compact.text).toContain("Target B");
    expect(compact.text).toContain("Use the secondary style.");
    expect(compact.text).not.toContain("Policy audit:");
    expect(forensic.text).toContain("Policy audit (reference only):");
    expect(forensic.text.length).toBeGreaterThan(compact.text.length);
  });

  test("groups repeated annotations on one element in feedback copy", () => {
    const first = createCaptureRecord("save", "Save changes");
    first.intent = "First comment.";
    first.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.5,
    };
    const second = structuredClone(first);
    second.intent = "Second comment.";
    second.capturedAt = "2026-07-11T10:03:00.000Z";
    second.attachment.capturedAt = second.capturedAt;
    second.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.75,
      yRatio: 0.5,
    };
    const file = createSessionFile([first, second]);
    file.session.attachments[1]!.id = "att_save-2";

    const result = buildPanelAgentCopy({
      file,
      attachmentIds: ["att_save", "att_save-2"],
      selectedItemId: "att_save-2",
      selectedRecord: second,
      viewMode: "agent_safe",
      intent: "Second comment.",
      outputDetail: "standard",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachmentCount).toBe(1);
    expect(result.text.match(/Target A/gu)).toHaveLength(1);
    expect(result.text).not.toContain("Target B");
    expect(result.text).toContain("Annotation 1 task note: First comment.");
    expect(result.text).toContain("Annotation 2 task note: Second comment.");
  });

  test.each(["compact", "standard", "detailed", "forensic"] as const)(
    "%s feedback keeps mixed lifecycle on repeated targets without inventing legacy state",
    (outputDetail) => {
      const first = createCaptureRecord("save", "Save changes");
      const second = structuredClone(first);
      second.intent = "Second comment.";
      const legacy = createSessionFile([first, second]);
      legacy.session.attachments[1]!.id = "att_save-2";
      const input = {
        file: legacy, attachmentIds: ["att_save", "att_save-2"], selectedItemId: "att_save-2",
        selectedRecord: second, viewMode: "agent_safe" as const, intent: second.intent, outputDetail,
      };
      const legacyCopy = buildPanelAgentCopy(input);
      expect(legacyCopy.ok).toBe(true);
      if (!legacyCopy.ok) return;
      expect(legacyCopy.attachmentCount).toBe(1);
      expect(legacyCopy.text).not.toContain("lifecycle:");
      const file = structuredClone(legacy) as unknown as CaptureSessionFileV3;
      file.schemaVersion = "0.3.0";
      file.session.updatedAt = "2026-07-11T10:04:00.000Z";
      file.session.attachments = file.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `annotation-${index + 1}`,
        updatedAt: "2026-07-11T10:03:00.000Z",
        annotationLifecycle: index === 0
          ? { state: "open" as const, resolvedAt: null }
          : { state: "resolved" as const, resolvedAt: "2026-07-11T10:03:00.000Z" },
      }));
      const currentCopy = buildPanelAgentCopy({ ...input, file });
      expect(currentCopy.ok).toBe(true);
      if (!currentCopy.ok) return;
      expect(currentCopy.attachmentCount).toBe(1);
      expect(currentCopy.text.match(/Target A/gu)).toHaveLength(1);
      expect(currentCopy.text).not.toContain("Target B");
      expect(currentCopy.text).toContain("Annotation 1 lifecycle: open; resolvedAt=null");
      expect(currentCopy.text).toContain("Annotation 2 lifecycle: resolved; resolvedAt=2026-07-11T10:03:00.000Z");
      expect(currentCopy.text).toContain("Annotation 1 task note: Update Save changes");
      expect(currentCopy.text).toContain("Annotation 2 task note: Second comment.");
    },
  );

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
