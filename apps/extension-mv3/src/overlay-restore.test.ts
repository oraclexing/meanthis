import { describe, expect, test, vi } from "vitest";
import type { OriginCaptureRecord } from "./capture-store";
import {
  commitLiveOverlayCapture,
  createCurrentOverlayRestoreItem,
} from "./overlay-restore";

describe("createCurrentOverlayRestoreItem", () => {
  test("creates a bounded replay descriptor only for the current canonical route", () => {
    const record = createRecord();
    record.intent = "Current marker note";
    record.attachment.selectionPoint = {
      kind: "element_relative_pointer",
      xRatio: 0.25,
      yRatio: 0.75,
    };
    const receipt = {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      annotationLabel: "1",
    };

    expect(createCurrentOverlayRestoreItem(
      record,
      receipt,
      "https://app.example.test/settings?view=compact#save",
    )).toEqual({
      itemId: "att_save",
      attachmentId: "att_save",
      label: "1",
      taskNote: "Current marker note",
      anchor: { xRatio: 0.25, yRatio: 0.75 },
      locators: [{
        strategy: "playwright.testId",
        value: 'page.getByTestId("save")',
        confidence: 0.9,
      }],
    });
    expect(createCurrentOverlayRestoreItem(
      record,
      receipt,
      "https://app.example.test/another-page",
    )).toBeNull();
  });

  test("prefers capture-verified stable identities before a volatile verified locator", () => {
    const record = createRecord();
    const roleLocator = {
      strategy: "playwright.role" as const,
      value: 'page.getByRole("button", { name: "Likes 10" })',
      confidence: 0.92,
    };
    const testIdLocator = {
      strategy: "playwright.testId" as const,
      value: 'page.getByTestId("like-button")',
      confidence: 0.86,
    };
    const idLocator = {
      strategy: "css" as const,
      value: "#like-button",
      confidence: 0.68,
    };
    const anchoredLocator = {
      strategy: "css" as const,
      value: 'article:has(a[href="/alice/status/1952521961831320123"]) [data-testid="like"]',
      confidence: 0.64,
      notes: "descendant anchored fallback",
    };
    record.attachment.locatorBundle = {
      primary: roleLocator,
      candidates: [roleLocator, testIdLocator, idLocator, anchoredLocator],
      stability: {
        score: 72,
        uniqueness: true,
        replayVerified: true,
        failureReason: null,
        verifiedBy: roleLocator.strategy,
        verifiedValue: roleLocator.value,
      },
    };
    record.replayAttempts = [
      verifiedAttempt(roleLocator),
      verifiedAttempt(testIdLocator),
      verifiedAttempt(idLocator),
      verifiedAttempt(anchoredLocator),
    ];

    expect(createCurrentOverlayRestoreItem(
      record,
      {
        origin: "https://app.example.test",
        epoch: "epoch-1",
        itemId: "att_save",
        annotationLabel: "1",
      },
      "https://app.example.test/settings",
    )?.locators).toEqual([
      testIdLocator,
      idLocator,
      {
        strategy: anchoredLocator.strategy,
        value: anchoredLocator.value,
        confidence: anchoredLocator.confidence,
      },
      roleLocator,
    ]);
  });

  test("uses only a capture-verified content anchor across same-origin page views", () => {
    const record = createRecord();
    record.pageUrl = "https://app.example.test/feed";
    const volatileLocator = {
      strategy: "playwright.role" as const,
      value: 'page.getByRole("button", { name: "Likes 10" })',
      confidence: 0.92,
    };
    const anchoredLocator = {
      strategy: "css" as const,
      value: 'article:has(a[href="/alice/status/1952521961831320123"]) [data-testid="like"]',
      confidence: 0.64,
      notes: "descendant anchored fallback",
    };
    record.attachment.locatorBundle = {
      primary: volatileLocator,
      candidates: [volatileLocator, anchoredLocator],
      stability: {
        score: 72,
        uniqueness: true,
        replayVerified: true,
        failureReason: null,
        verifiedBy: volatileLocator.strategy,
        verifiedValue: volatileLocator.value,
      },
    };
    record.replayAttempts = [
      verifiedAttempt(volatileLocator),
      verifiedAttempt(anchoredLocator),
    ];

    expect(createCurrentOverlayRestoreItem(
      record,
      {
        origin: "https://app.example.test",
        epoch: "epoch-1",
        itemId: "att_save",
        annotationLabel: "1",
      },
      "https://app.example.test/alice/status/1952521961831320123",
    )?.locators).toEqual([{
      strategy: anchoredLocator.strategy,
      value: anchoredLocator.value,
      confidence: anchoredLocator.confidence,
    }]);
  });

  test("rejects a note-spoofed CSS candidate across page views", () => {
    const record = createRecord();
    record.pageUrl = "https://app.example.test/feed";
    const spoofedLocator = {
      strategy: "css" as const,
      value: ".dynamic-action",
      confidence: 0.64,
      notes: "descendant anchored fallback",
    };
    record.attachment.locatorBundle = {
      primary: spoofedLocator,
      candidates: [spoofedLocator],
      stability: {
        score: 64,
        uniqueness: true,
        replayVerified: true,
        failureReason: null,
        verifiedBy: spoofedLocator.strategy,
        verifiedValue: spoofedLocator.value,
      },
    };
    record.replayAttempts = [verifiedAttempt(spoofedLocator)];

    expect(createCurrentOverlayRestoreItem(
      record,
      {
        origin: "https://app.example.test",
        epoch: "epoch-1",
        itemId: "att_save",
        annotationLabel: "1",
      },
      "https://app.example.test/items/stable-item",
    )).toBeNull();
  });

  test("ignores malformed historical replay attempts", () => {
    const record = createRecord();
    const roleLocator = {
      strategy: "playwright.role" as const,
      value: 'page.getByRole("button", { name: "Likes 10" })',
      confidence: 0.92,
    };
    const testIdLocator = {
      strategy: "playwright.testId" as const,
      value: 'page.getByTestId("like-button")',
      confidence: 0.86,
    };
    record.attachment.locatorBundle = {
      primary: roleLocator,
      candidates: [roleLocator, testIdLocator],
      stability: {
        score: 72,
        uniqueness: true,
        replayVerified: true,
        failureReason: null,
        verifiedBy: roleLocator.strategy,
        verifiedValue: roleLocator.value,
      },
    };
    record.replayAttempts = [{
      strategy: "playwright.testId",
      value: testIdLocator.value,
      replayVerified: true,
      uniqueness: true,
      failureReason: null,
      matchCount: 1,
      visible: false,
    }];

    expect(createCurrentOverlayRestoreItem(
      record,
      {
        origin: "https://app.example.test",
        epoch: "epoch-1",
        itemId: "att_save",
        annotationLabel: "1",
      },
      "https://app.example.test/settings",
    )?.locators).toEqual([roleLocator]);
  });

  test("binds a coordinate-only capture to its live target without inventing replay identity", async () => {
    const record = createRecord();
    record.attachment.locatorBundle = {
      primary: {
        strategy: "coordinates",
        value: "0,0,100,30",
        confidence: 0.2,
      },
      candidates: [],
      stability: null,
    };
    const receipt = {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      annotationLabel: "1",
    };
    const target = { isConnected: true } as HTMLElement;
    const trackCurrentRoute = vi.fn();
    const bindLiveTarget = vi.fn();
    const bindReplayTarget = vi.fn(async () => {});

    await commitLiveOverlayCapture({
      record,
      receipt,
      currentUrl: "https://app.example.test/settings",
      target,
      trackCurrentRoute,
      bindLiveTarget,
      bindReplayTarget,
    });

    expect(trackCurrentRoute).toHaveBeenCalledOnce();
    expect(bindLiveTarget).toHaveBeenCalledWith(target, receipt);
    expect(bindReplayTarget).not.toHaveBeenCalled();
  });

  test("keeps an ambiguous locator on the exact live target without background replay", async () => {
    const record = createRecord();
    record.attachment.locatorBundle.stability = {
      score: 72,
      uniqueness: false,
      replayVerified: false,
      failureReason: "locator matched 3 elements",
      verifiedBy: null,
      verifiedValue: null,
    };
    const receipt = {
      origin: "https://app.example.test",
      epoch: "epoch-1",
      itemId: "att_save",
      annotationLabel: "1",
    };
    const target = { isConnected: true } as HTMLElement;
    const trackCurrentRoute = vi.fn();
    const bindLiveTarget = vi.fn();
    const bindReplayTarget = vi.fn(async () => {});

    expect(createCurrentOverlayRestoreItem(
      record,
      receipt,
      "https://app.example.test/settings",
    )).toBeNull();

    await commitLiveOverlayCapture({
      record,
      receipt,
      currentUrl: "https://app.example.test/settings",
      target,
      trackCurrentRoute,
      bindLiveTarget,
      bindReplayTarget,
    });

    expect(trackCurrentRoute).toHaveBeenCalledOnce();
    expect(bindLiveTarget).toHaveBeenCalledWith(target, receipt);
    expect(bindReplayTarget).not.toHaveBeenCalled();
  });
});

function createRecord(): OriginCaptureRecord {
  return {
    origin: "https://app.example.test",
    pageUrl: "https://app.example.test/settings",
    pageTitle: "Settings",
    attachment: {
      schemaVersion: "0.3.0",
      id: "att_save",
      capturedAt: "2026-07-22T00:00:00.000Z",
      source: { kind: "web", url: "https://app.example.test/settings", title: "Settings" },
      element: {
        tagName: "button",
        role: "button",
        text: "Save",
        accessibleName: "Save",
        bbox: { x: 0, y: 0, width: 100, height: 30 },
        visible: true,
        enabled: true,
      },
      style: {
        display: "block",
        color: "rgb(0, 0, 0)",
        backgroundColor: "rgb(255, 255, 255)",
      },
      context: { parentSummary: null, nearbyText: [], selectorHints: [] },
      locatorBundle: {
        primary: {
          strategy: "playwright.testId",
          value: 'page.getByTestId("save")',
          confidence: 0.9,
        },
        candidates: [],
        stability: {
          score: 72,
          uniqueness: true,
          replayVerified: true,
          failureReason: null,
          verifiedBy: "playwright.testId",
          verifiedValue: 'page.getByTestId("save")',
        },
      },
      policy: {
        disclosureMode: "agent_safe",
        redactionLevel: "strict",
        actionMode: "suggest_patch",
        allowScreenshot: false,
        allowDomSnippet: false,
        allowNetworkSend: false,
        allowedDomains: ["https://app.example.test"],
        redactedFields: [],
        sensitiveHints: [],
        includedSensitiveFields: [],
      },
      artifacts: { screenshotCrop: null, overlayImage: null },
    },
    intent: "",
    markdown: "# Save",
    capturedAt: "2026-07-22T00:00:00.000Z",
  };
}

function verifiedAttempt(locator: {
  strategy: "playwright.role" | "playwright.testId" | "css";
  value: string;
}) {
  return {
    strategy: locator.strategy,
    value: locator.value,
    replayVerified: true,
    uniqueness: true,
    failureReason: null,
    matchCount: 1,
    visible: true,
  };
}
