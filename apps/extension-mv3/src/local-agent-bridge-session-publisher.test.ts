import type {
  CaptureSessionFile,
  CaptureSessionFileV2,
  CaptureSessionFileV3,
} from "@meanthis/hub-core";
import type { MetadataDiagnosticsV1 } from "@meanthis/schema";
import { describe, expect, test, vi } from "vitest";
import { createCaptureRecord, createSessionFile } from "../test/session-fixtures";
import type { OriginCaptureRecord } from "./capture-store";
import type { LocalAgentBridgePublishInput } from "./local-agent-bridge";
import {
  createLocalAgentBridgeSessionPublisher,
  type LocalAgentBridgeSessionPublisherBridge,
} from "./local-agent-bridge-session-publisher";
import type { ActiveSessionCommandData } from "./messages";

describe("local agent bridge session publisher", () => {
  test("atomically clears every shared page source for an invalidated active page", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await expect(publisher.clearActivePageContext()).resolves.toBe(true);

    expect(bridge.clearSharedCapture).toHaveBeenCalledOnce();
    expect(bridge.clearSessionContext).not.toHaveBeenCalled();

    bridge.clearSharedCapture.mockRejectedValueOnce(new Error("shared clear failed"));
    await expect(publisher.clearActivePageContext()).resolves.toBe(false);
    expect(bridge.clearSharedCapture).toHaveBeenCalledTimes(2);
  });

  test("returns the decisive Bridge publication result without failing session authority", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");
    bridge.publishSessionContext.mockResolvedValueOnce(false);
    await expect(publisher.reconcile(createActiveData(createSessionFile([save]), "att_save")))
      .resolves.toBe(false);
    bridge.publishSessionContext.mockRejectedValueOnce(new Error("offline"));
    await expect(publisher.reconcile(createActiveData(createSessionFile([save]), "att_save")))
      .resolves.toBe(false);
    bridge.publishSessionContext.mockResolvedValueOnce(true);
    await expect(publisher.reconcile(createActiveData(createSessionFile([save]), "att_save")))
      .resolves.toBe(true);
  });

  test("accepts V2 session metadata without mutating or synthesizing it", async () => {
    const record = createCaptureRecord("save", "Save changes");
    const file = createV2SessionFile([record]);
    const before = structuredClone(file);
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await publisher.reconcile(createActiveData(file, "att_save"));

    expect(file).toEqual(before);
    expect(bridge.publishSessionContext).toHaveBeenCalledOnce();
    expect(file.session.attachments[0]).toMatchObject({
      annotationId: "annotation:1",
      updatedAt: record.capturedAt,
    });
  });

  test("projects V3 session lifecycle metadata into the production session publisher readback", async () => {
    const record = createCaptureRecord("save", "Save changes");
    const file = createV3SessionFile([record]);
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await publisher.reconcile(createActiveData(file, "att_save"));

    const input = bridge.publishSessionContext.mock.calls[0]?.[0] as LocalAgentBridgePublishInput;
    expect(input.capture).toMatchObject({
      annotationLifecycleVersion: "v1",
      targets: [{
        annotationId: "annotation:1",
        annotationLifecycle: { state: "open", resolvedAt: null },
      }],
    });
  });

  test("publishes the authoritative page scope as agent-safe capture-time data", async () => {
    const save = createCaptureRecord("save", "Save changes", "full_debug");
    const cancel = createCaptureRecord("cancel", "Cancel");
    cancel.intent = "Use a secondary style.";
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await publisher.reconcile(createActiveData(createSessionFile([save, cancel]), "att_cancel"));

    expect(bridge.publishSessionContext).toHaveBeenCalledOnce();
    const input = bridge.publishSessionContext.mock.calls[0]![0] as LocalAgentBridgePublishInput;
    expect(input).toMatchObject({
      page: {
        pageInstanceId: "chromium-tab:1:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 2,
      capture: {
        captureId: "session-1",
        authority: "capture_time",
        disclosureMode: "agent_safe",
        metadataDiagnostics: {
          captureId: "session-1",
          authority: "capture_time",
          replay: {
            status: "collected",
            attemptCount: 0,
            verifiedCount: 0,
            ambiguousCount: 0,
            missingCount: 0,
          },
          device: { status: "not_requested" },
          network: { status: "not_requested" },
          console: { status: "not_requested" },
        },
        targets: [
          { attachmentId: "att_save", taskNote: "Update Save changes" },
          { attachmentId: "att_cancel", taskNote: "Use a secondary style." },
        ],
      },
    });
    expect(input.agentCopy).toContain("MeanThis Capture Bundle");
    expect(input).not.toHaveProperty("observations");
    expect(input).not.toHaveProperty("activity");
    expect(JSON.stringify(input)).not.toContain("ada@example.com");
    expect(JSON.stringify(input)).not.toContain("sk-test-1234567890");
  });

  test("forwards supplied coarse device metadata without exposing raw environment fields", async () => {
    const save = createCaptureRecord("save", "Save changes");
    save.replayAttempts = [{
      strategy: "playwright.role",
      value: 'page.getByRole("button", { name: "Save changes" })',
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount: 1,
      visible: true,
    }];
    const data = createActiveData(createSessionFile([save]), "att_save");
    const supplied: MetadataDiagnosticsV1 = {
      schemaVersion: "0.1.0",
      kind: "ui-attach.metadata-only-diagnostics",
      captureId: "session-1",
      scope: "capture",
      observedAt: "2026-07-11T09:59:00.000Z",
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
    data.metadataDiagnostics = supplied;
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await publisher.reconcile(data);

    const input = bridge.publishSessionContext.mock.calls[0]![0] as LocalAgentBridgePublishInput;
    expect(input.capture).toMatchObject({
      captureId: "session-1",
      authority: "capture_time",
      metadataDiagnostics: {
        observedAt: supplied.observedAt,
        replay: {
          status: "collected",
          attemptCount: 1,
          verifiedCount: 1,
          ambiguousCount: 0,
          missingCount: 0,
        },
        device: supplied.device,
        network: { status: "not_requested" },
        console: { status: "not_requested" },
      },
    });
    const diagnostics = input.capture?.metadataDiagnostics;
    expect(diagnostics?.device).toEqual({
      status: "collected",
      deviceClass: "desktop",
      viewportClass: "large",
      touch: "coarse",
    });
    for (const rawField of ["viewportWidth", "userAgent", "url", "path"]) {
      expect(diagnostics).not.toHaveProperty(rawField);
    }
    expect(diagnostics?.network).toEqual({ status: "not_requested" });
    expect(diagnostics?.console).toEqual({ status: "not_requested" });
    expect(JSON.stringify(diagnostics)).not.toContain("network text");
    expect(JSON.stringify(diagnostics)).not.toContain("console text");
  });

  test("publishes restored current-scope targets when live widget authority supersedes stale frame identity", async () => {
    const first = createCaptureRecord("first", "First restored target");
    const second = createCaptureRecord("second", "Second restored target");
    for (const record of [first, second]) {
      record.tabId = 91;
      record.frameId = 9;
      record.origin = "https://embed.example.test";
      record.pageUrl = "https://embed.example.test/editor";
      record.attachment.source.url = "https://embed.example.test/editor";
      record.attachment.policy.allowedDomains = ["https://embed.example.test"];
      record.routeChain = [
        { origin: "https://app.example.test", pathname: "/settings" },
        { origin: "https://embed.example.test", pathname: "/editor" },
      ];
    }
    const file = createSessionFile([first, second]);
    file.session.origin = "https://embed.example.test";
    const data = Object.assign(
      createActiveData(file, first.attachment.id),
      {
        currentItemIds: [first.attachment.id, second.attachment.id],
        activePage: {
          tabId: 1,
          frameId: 9,
          documentId: "live-embedded-document",
          origin: "https://embed.example.test",
          pathname: "/editor",
        },
      },
    );
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await publisher.reconcile(data);

    expect(bridge.publishSessionContext).toHaveBeenCalledOnce();
    expect(bridge.publishSessionContext).toHaveBeenCalledWith(expect.objectContaining({
      page: {
        pageInstanceId: "chromium-tab:1:frame:9",
        route: "https://embed.example.test/editor",
      },
      attachmentCount: 2,
      capture: expect.objectContaining({
        targets: [
          expect.objectContaining({ attachmentId: first.attachment.id }),
          expect.objectContaining({ attachmentId: second.attachment.id }),
        ],
      }),
    }));
    const input = bridge.publishSessionContext.mock.calls[0]![0] as LocalAgentBridgePublishInput;
    expect(input.agentCopy).toContain("instance `chromium-tab:91:frame:9`");
    expect(input.agentCopy).toContain("tab `91`; frame `9`");
    expect(input.agentCopy).toContain("route `https://embed.example.test/editor`");
    expect(input.agentCopy).not.toContain("instance `chromium-tab:1:frame:9`");
  });

  test("does not publish a selected stale target when live widget authority says the current scope is empty", async () => {
    const stale = createCaptureRecord("stale", "Stale target");
    const data = Object.assign(
      createActiveData(createSessionFile([stale]), stale.attachment.id),
      { currentItemIds: [] as string[] },
    );
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);

    await publisher.reconcile(data);

    expect(bridge.publishSessionContext).toHaveBeenCalledWith({
      page: {
        pageInstanceId: "chromium-tab:1:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 0,
      agentCopy: null,
    });
  });

  test("coalesces queued readbacks so the newest snapshot wins", async () => {
    const firstPublish = createDeferred<boolean>();
    const bridge = createBridge();
    bridge.publishSessionContext.mockImplementationOnce(() => firstPublish.promise);
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const first = createCaptureRecord("first", "First target");
    const superseded = createCaptureRecord("second", "Superseded target");
    const newest = createCaptureRecord("third", "Newest target");

    const firstDone = publisher.reconcile(createActiveData(
      createSessionFile([first]),
      first.attachment.id,
    ));
    const supersededDone = publisher.reconcile(createActiveData(
      createSessionFile([superseded]),
      superseded.attachment.id,
    ));
    const newestData = createActiveData(
      createSessionFile([newest]),
      newest.attachment.id,
    );
    const newestDone = publisher.reconcile(newestData);
    const queuedRecord = newestData.readback!.file!.session.attachments[0]!
      .sourceRecord as OriginCaptureRecord;
    queuedRecord.intent = "Mutated after enqueue";
    expect(bridge.publishSessionContext).toHaveBeenCalledOnce();

    firstPublish.resolve(true);
    await Promise.all([firstDone, supersededDone, newestDone]);

    expect(bridge.publishSessionContext).toHaveBeenCalledTimes(2);
    expect(bridge.publishSessionContext.mock.calls[1]![0]).toMatchObject({
      capture: {
        targets: [{ attachmentId: "att_third", taskNote: "Update Newest target" }],
      },
    });
    expect(JSON.stringify(bridge.publishSessionContext.mock.calls[1]![0])).not.toContain("Mutated after enqueue");
    expect(JSON.stringify(bridge.publishSessionContext.mock.calls[1]![0])).not.toContain("att_second");
  });

  test("keeps the focused page visible to the agent after the last canonical item is removed", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");

    await publisher.reconcile(createActiveData(createSessionFile([save]), "att_save"));
    await publisher.reconcile(createActiveData(createSessionFile([]), null));

    expect(bridge.publishSessionContext).toHaveBeenCalledTimes(2);
    expect(bridge.publishSessionContext.mock.calls[1]![0]).toEqual({
      page: {
        pageInstanceId: "chromium-tab:1:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 0,
      agentCopy: null,
    });
    expect(bridge.clearSessionContext).not.toHaveBeenCalled();
  });

  test("clears the focused context when the MeanThis page is no longer available", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");

    await publisher.reconcile(createActiveData(createSessionFile([save]), "att_save"));
    const unavailable = createActiveData(createSessionFile([]), null);
    unavailable.enabled = false;
    unavailable.activePage = null;
    await publisher.reconcile(unavailable);

    expect(bridge.clearSessionContext).toHaveBeenCalledOnce();

    const idleBridge = createBridge();
    const idlePublisher = createLocalAgentBridgeSessionPublisher(idleBridge);
    await idlePublisher.reconcile(unavailable);
    expect(idleBridge.clearSessionContext).toHaveBeenCalledOnce();
  });

  test("fails closed instead of replacing a capture with page-only data when session authority is unavailable", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");

    await publisher.reconcile(createActiveData(createSessionFile([save]), "att_save"));
    const unavailable = createActiveData(createSessionFile([]), null);
    unavailable.readback = null;
    await publisher.reconcile(unavailable);

    expect(bridge.publishSessionContext).toHaveBeenCalledOnce();
    expect(bridge.clearSessionContext).toHaveBeenCalledOnce();
  });

  test("clears the prior shared context when the selected route is not safe to disclose", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");

    await publisher.reconcile(createActiveData(createSessionFile([save]), "att_save"));
    const sensitive = createActiveData(createSessionFile([]), null);
    sensitive.activePage!.pathname = "/users/alice@example.test";
    await publisher.reconcile(sensitive);

    expect(bridge.publishSessionContext).toHaveBeenCalledOnce();
    expect(bridge.clearSessionContext).toHaveBeenCalledOnce();
  });

  test("never republishes a stale non-empty file while canonical clear is pending", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");
    const data = createActiveData(createSessionFile([save]), "att_save");
    data.readback!.clearPending = true;
    data.readback!.activeClearOperationId = "clear-1";

    await publisher.reconcile(data);

    expect(bridge.publishSessionContext).not.toHaveBeenCalled();
    expect(bridge.clearSessionContext).toHaveBeenCalledOnce();
  });

  test("replaces a stale capture with the verified page when record routing is unavailable", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");
    await publisher.reconcile(createActiveData(createSessionFile([save]), "att_save"));

    const unroutable = createCaptureRecord("unroutable", "Unroutable target");
    unroutable.capturedAt = "not-a-canonical-date";
    await publisher.reconcile(createActiveData(
      createSessionFile([unroutable]),
      unroutable.attachment.id,
    ));

    expect(bridge.publishSessionContext).toHaveBeenCalledTimes(2);
    expect(bridge.publishSessionContext.mock.calls[1]![0]).toEqual({
      page: {
        pageInstanceId: "chromium-tab:1:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 0,
      agentCopy: null,
    });
    expect(bridge.clearSessionContext).not.toHaveBeenCalled();
  });

  test("replaces an unprojectable legacy record with the verified page instead of keeping stale context", async () => {
    const bridge = createBridge();
    const publisher = createLocalAgentBridgeSessionPublisher(bridge);
    const save = createCaptureRecord("save", "Save changes");
    await publisher.reconcile(createActiveData(createSessionFile([save]), "att_save"));

    const legacy = createActiveData(createSessionFile([]), null);
    legacy.readback!.legacyRecord = createCaptureRecord("legacy", "Legacy target");
    await publisher.reconcile(legacy);

    expect(bridge.publishSessionContext).toHaveBeenCalledTimes(2);
    expect(bridge.publishSessionContext.mock.calls[1]![0]).toMatchObject({
      page: {
        pageInstanceId: "chromium-tab:1:frame:0",
        route: "https://app.example.test/settings",
      },
      attachmentCount: 0,
      agentCopy: null,
    });
    expect(bridge.clearSessionContext).not.toHaveBeenCalled();
  });
});

function createActiveData(
  file: CaptureSessionFile,
  selectedItemId: string | null,
): ActiveSessionCommandData {
  return {
    enabled: true,
    origin: file.session.origin,
    readback: {
      origin: file.session.origin,
      epoch: "epoch-1",
      clearPending: false,
      activeClearOperationId: null,
      file,
      legacyRecord: file.session.attachments.at(-1)?.sourceRecord as OriginCaptureRecord ?? null,
    },
    activePage: {
      tabId: 1,
      frameId: 0,
      origin: file.session.origin,
      pathname: "/settings",
    },
    selectedItemId,
  };
}

function createV2SessionFile(records: OriginCaptureRecord[]): CaptureSessionFileV2 {
  const legacyFile = createSessionFile(records);
  return {
    ...legacyFile,
    schemaVersion: "0.2.0",
    session: {
      ...legacyFile.session,
      attachments: legacyFile.session.attachments.map((item, index) => ({
        ...item,
        annotationId: `annotation:${index + 1}`,
        updatedAt: item.createdAt,
      })),
    },
  };
}

function createV3SessionFile(records: OriginCaptureRecord[]): CaptureSessionFileV3 {
  const v2 = createV2SessionFile(records);
  return {
    ...v2,
    schemaVersion: "0.3.0",
    session: {
      ...v2.session,
      attachments: v2.session.attachments.map((item) => ({
        ...item,
        annotationLifecycle: { state: "open" as const, resolvedAt: null },
      })),
    },
  };
}

function createBridge() {
  return {
    publishSessionContext: vi.fn(async (_input: LocalAgentBridgePublishInput) => true),
    clearSessionContext: vi.fn(async () => true),
    clearSharedCapture: vi.fn(async () => true),
  } satisfies LocalAgentBridgeSessionPublisherBridge;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
