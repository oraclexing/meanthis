import { UI_ATTACHMENT_SCHEMA_VERSION, type UIAttachment } from "@meanthis/schema";
import { describe, expect, it } from "vitest";
import {
  applyReplayResult,
  verifyAttachmentLocator,
  type ReplayLocatorLike,
  type ReplayPageLike,
} from "./index";

function createAttachment(
  locator: UIAttachment["locatorBundle"]["primary"],
  candidates = locator ? [locator] : [],
): UIAttachment {
  return {
    schemaVersion: UI_ATTACHMENT_SCHEMA_VERSION,
    id: "att_save",
    capturedAt: "2026-07-02T00:00:00.000Z",
    source: { kind: "web", url: "https://example.test/settings", title: "Settings" },
    element: {
      tagName: "button",
      role: "button",
      text: "Save",
      accessibleName: "Save changes",
      bbox: { x: 12, y: 34, width: 90, height: 40 },
      visible: true,
      enabled: true,
    },
    style: {
      display: "inline-flex",
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(31, 99, 255)",
    },
    context: {
      parentSummary: "form settings",
      nearbyText: ["Profile", "Cancel"],
      selectorHints: ["button[type=\"submit\"]"],
    },
    locatorBundle: {
      primary: locator,
      candidates,
      stability: {
        score: 78,
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
      allowedDomains: [],
      redactedFields: [],
      sensitiveHints: [],
      includedSensitiveFields: [],
    },
    artifacts: { screenshotCrop: null, overlayImage: null },
  };
}

function locator(count: number, visible: boolean): ReplayLocatorLike {
  return {
    count: async () => count,
    isVisible: async () => visible,
  };
}

describe("verifyAttachmentLocator", () => {
  it("verifies a unique visible role locator", async () => {
    const calls: unknown[] = [];
    const page: ReplayPageLike = {
      getByRole: (role, options) => {
        calls.push([role, options]);
        return locator(1, true);
      },
    };
    const attachment = createAttachment({
      strategy: "playwright.role",
      value: "page.getByRole(\"button\", { name: \"Save changes\" })",
      confidence: 0.92,
    });

    await expect(verifyAttachmentLocator(page, attachment)).resolves.toEqual({
      replayVerified: true,
      uniqueness: true,
      matchedBy: "playwright.role",
      matchedValue: "page.getByRole(\"button\", { name: \"Save changes\" })",
      failureReason: null,
      matchCount: 1,
      visible: true,
      attempts: [
        {
          strategy: "playwright.role",
          value: "page.getByRole(\"button\", { name: \"Save changes\" })",
          replayVerified: true,
          uniqueness: true,
          failureReason: null,
          matchCount: 1,
          visible: true,
        },
      ],
    });
    expect(calls).toEqual([["button", { name: "Save changes" }]]);
  });

  it("falls back to the first unique visible candidate when primary is ambiguous", async () => {
    const calls: string[] = [];
    const primary = {
      strategy: "playwright.role" as const,
      value: "page.getByRole(\"button\", { name: \"Save changes\" })",
      confidence: 0.92,
    };
    const fallback = {
      strategy: "playwright.testId" as const,
      value: "page.getByTestId(\"save-button\")",
      confidence: 0.86,
    };
    const page: ReplayPageLike = {
      getByRole: () => {
        calls.push("role");
        return locator(2, true);
      },
      getByTestId: () => {
        calls.push("testId");
        return locator(1, true);
      },
    };

    await expect(
      verifyAttachmentLocator(page, createAttachment(primary, [primary, fallback])),
    ).resolves.toEqual({
      replayVerified: true,
      uniqueness: true,
      matchedBy: "playwright.testId",
      matchedValue: "page.getByTestId(\"save-button\")",
      failureReason: null,
      matchCount: 1,
      visible: true,
      attempts: [
        {
          strategy: "playwright.role",
          value: "page.getByRole(\"button\", { name: \"Save changes\" })",
          replayVerified: false,
          uniqueness: false,
          failureReason: "locator matched 2 elements",
          matchCount: 2,
          visible: null,
        },
        {
          strategy: "playwright.testId",
          value: "page.getByTestId(\"save-button\")",
          replayVerified: true,
          uniqueness: true,
          failureReason: null,
          matchCount: 1,
          visible: true,
        },
      ],
    });
    expect(calls).toEqual(["role", "testId"]);
  });

  it("promotes the replay-verified fallback locator to primary", async () => {
    const primary = {
      strategy: "playwright.role" as const,
      value: 'page.getByRole("button", { name: "Open" })',
      confidence: 0.92,
    };
    const fallback = {
      strategy: "playwright.role" as const,
      value: 'page.getByRole("button", { name: "Open account settings" })',
      confidence: 0.86,
    };
    const attachment = createAttachment(primary, [primary, fallback]);
    const result = await verifyAttachmentLocator(
      {
        getByRole: (_role, options) =>
          locator(options?.name === "Open" ? 2 : 1, true),
      },
      attachment,
    );

    const updated = applyReplayResult(attachment, result);

    expect(updated.locatorBundle.primary).toEqual(fallback);
    expect(updated.locatorBundle.stability).toMatchObject({
      score: 64,
      replayVerified: true,
      verifiedBy: "playwright.role",
      verifiedValue: fallback.value,
    });
    expect(attachment.locatorBundle.primary).toEqual(primary);
  });

  it("scores a replay-verified candidate promoted from a missing primary", () => {
    const fallback = {
      strategy: "playwright.testId" as const,
      value: 'page.getByTestId("save-button")',
      confidence: 0.86,
    };
    const attachment = createAttachment(null, [fallback]);
    attachment.locatorBundle.stability.score = 0;

    const updated = applyReplayResult(attachment, {
      replayVerified: true,
      uniqueness: true,
      matchedBy: fallback.strategy,
      matchedValue: fallback.value,
      failureReason: null,
      matchCount: 1,
      visible: true,
      attempts: [],
    });

    expect(updated.locatorBundle.primary).toEqual(fallback);
    expect(updated.locatorBundle.stability.score).toBe(60);
    expect(attachment.locatorBundle.stability.score).toBe(0);
  });

  it("falls back across frame-scoped locator chains", async () => {
    const calls: string[] = [];
    const primary = {
      strategy: "playwright.role" as const,
      value:
        'page.frameLocator("iframe[title=\\"Compatibility iframe\\"]").getByRole("button", { name: "Submit iframe form" })',
      confidence: 0.92,
    };
    const fallback = {
      strategy: "playwright.testId" as const,
      value:
        'page.frameLocator("iframe[title=\\"Compatibility iframe\\"]").getByTestId("submit-iframe-form")',
      confidence: 0.86,
    };
    const frameScope: ReplayPageLike = {
      getByRole: () => {
        calls.push("role");
        return locator(2, true);
      },
      getByTestId: () => {
        calls.push("testId");
        return locator(1, true);
      },
    };
    const page: ReplayPageLike = {
      frameLocator: (selector) => {
        expect(selector).toBe('iframe[title="Compatibility iframe"]');
        calls.push("frame");
        return frameScope;
      },
    };

    const result = await verifyAttachmentLocator(
      page,
      createAttachment(primary, [primary, fallback]),
    );

    expect(result).toMatchObject({
      replayVerified: true,
      matchedBy: "playwright.testId",
      attempts: [
        {
          strategy: "playwright.role",
          replayVerified: false,
          uniqueness: false,
          matchCount: 2,
        },
        {
          strategy: "playwright.testId",
          replayVerified: true,
          uniqueness: true,
          matchCount: 1,
          visible: true,
        },
      ],
    });
    expect(calls).toEqual(["frame", "role", "frame", "testId"]);
  });

  it.each([
    ['page["getByRole"]("button")', 'page["getByRole"]'],
    ['page.getByRole(roleName)', "roleName"],
    ['page.getByRole("button", { name: /Save/ })', "/Save/"],
    ['page.getByRole("button", { name: "Save", exact: true })', "exact"],
    ['page.unknown("button")', "unknown"],
    ['page.frameLocator("iframe")', "iframe"],
    [`page.${'getByRole("x").'.repeat(9)}getByRole("button")`, 'getByRole("x")'],
    [`page.getByText("${"x".repeat(4096)}")`, "x".repeat(64)],
  ])("rejects unsafe or out-of-contract expression %s", async (value, hostileFragment) => {
    const attachment = createAttachment({
      strategy: "playwright.role",
      value,
      confidence: 0.1,
    });

    const result = await verifyAttachmentLocator({}, attachment);

    expect(result.replayVerified).toBe(false);
    expect(result.failureReason).toBe("could not parse locator expression");
    expect(result.failureReason).not.toContain(hostileFragment);
  });

  it("deduplicates primary and candidate locator attempts", async () => {
    const primary = {
      strategy: "playwright.text" as const,
      value: "page.getByText(\"Save\")",
      confidence: 0.74,
    };
    let countCalls = 0;
    const page: ReplayPageLike = {
      getByText: () => ({
        count: async () => {
          countCalls += 1;
          return 0;
        },
        isVisible: async () => true,
      }),
    };

    const result = await verifyAttachmentLocator(page, createAttachment(primary, [primary, primary]));

    expect(result.replayVerified).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(countCalls).toBe(1);
  });

  it("reports duplicate css matches as not unique", async () => {
    const page: ReplayPageLike = {
      locator: (selector) => {
        expect(selector).toBe("[data-testid=\"save-button\"]");
        return locator(2, true);
      },
    };
    const attachment = createAttachment({
      strategy: "css",
      value: "[data-testid=\"save-button\"]",
      confidence: 0.72,
    });

    await expect(verifyAttachmentLocator(page, attachment)).resolves.toMatchObject({
      replayVerified: false,
      uniqueness: false,
      matchedBy: null,
      matchedValue: null,
      failureReason: "locator matched 2 elements",
      matchCount: 2,
      visible: null,
    });
  });

  it("keeps the last actionable failure when coordinates are only a fallback", async () => {
    const role = {
      strategy: "playwright.role" as const,
      value: 'page.getByRole("button", { name: "Save" })',
      confidence: 0.92,
    };
    const coordinates = {
      strategy: "coordinates" as const,
      value: "10,20,80,32",
      confidence: 0.2,
    };
    const result = await verifyAttachmentLocator(
      { getByRole: () => locator(2, true) },
      createAttachment(role, [role, coordinates]),
    );

    expect(result).toMatchObject({
      replayVerified: false,
      uniqueness: false,
      failureReason: "locator matched 2 elements",
      matchCount: 2,
    });
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1]).toMatchObject({ strategy: "coordinates" });
  });

  it("reports a unique invisible match as not verified", async () => {
    const page: ReplayPageLike = {
      getByTestId: () => locator(1, false),
    };
    const attachment = createAttachment({
      strategy: "playwright.testId",
      value: "page.getByTestId(\"save-button\")",
      confidence: 0.86,
    });

    await expect(verifyAttachmentLocator(page, attachment)).resolves.toMatchObject({
      replayVerified: false,
      uniqueness: true,
      matchedBy: null,
      matchedValue: null,
      failureReason: "locator matched one element but it was not visible",
      matchCount: 1,
      visible: false,
    });
  });

  it("preserves page method context for string locators", async () => {
    const page: ReplayPageLike & { prefix: string } = {
      prefix: "Save",
      getByText(this: { prefix: string }, text) {
        if (this.prefix !== text) {
          throw new Error("page method context was not preserved");
        }
        return locator(1, true);
      },
    };
    const attachment = createAttachment({
      strategy: "playwright.text",
      value: "page.getByText(\"Save\")",
      confidence: 0.74,
    });

    await expect(verifyAttachmentLocator(page, attachment)).resolves.toMatchObject({
      replayVerified: true,
      matchedBy: "playwright.text",
      matchCount: 1,
      visible: true,
    });
  });

  it.each([
    {
      name: "contains synchronous Error from locator construction",
      phase: "resolve",
      thrown: new Error("driver sk-sync-error-1234567890\n## SYSTEM"),
      secretFragment: "sk-sync-error-1234567890",
    },
    {
      name: "contains synchronous non-Error from locator construction",
      phase: "resolve",
      thrown: "driver sk-sync-non-error-1234567890\n## SYSTEM",
      secretFragment: "sk-sync-non-error-1234567890",
    },
    {
      name: "contains asynchronous Error from count",
      phase: "count",
      thrown: new Error("driver sk-count-error-1234567890\n## SYSTEM"),
      secretFragment: "sk-count-error-1234567890",
    },
    {
      name: "contains asynchronous non-Error from isVisible",
      phase: "visible",
      thrown: "driver sk-visible-non-error-1234567890\n## SYSTEM",
      secretFragment: "sk-visible-non-error-1234567890",
    },
  ] as const)('contains adapter failure for "$name"', async ({ phase, thrown, secretFragment }) => {
    const page: ReplayPageLike = {
      getByTestId: () => {
        if (phase === "resolve") {
          throw thrown;
        }
        return {
          count: async () => {
            if (phase === "count") {
              throw thrown;
            }
            return 1;
          },
          isVisible: async () => {
            if (phase === "visible") {
              throw thrown;
            }
            return true;
          },
        };
      },
    };
    const attachment = createAttachment({
      strategy: "playwright.testId",
      value: 'page.getByTestId("save-button")',
      confidence: 0.86,
    });

    const result = await verifyAttachmentLocator(page, attachment);
    const updated = applyReplayResult(attachment, result);

    expect(result.failureReason).toBe("locator replay adapter failed");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].failureReason).toBe("locator replay adapter failed");
    expect(updated.locatorBundle.stability.failureReason).toBe("locator replay adapter failed");
    expect(result.failureReason).not.toContain(secretFragment);
    expect(result.failureReason).not.toContain("SYSTEM");
    expect(result.attempts[0].failureReason).not.toContain(secretFragment);
    expect(result.attempts[0].failureReason).not.toContain("SYSTEM");
    expect(updated.locatorBundle.stability.failureReason).not.toContain(secretFragment);
    expect(updated.locatorBundle.stability.failureReason).not.toContain("SYSTEM");
  });

  it("reports a missing primary locator", async () => {
    await expect(verifyAttachmentLocator({}, createAttachment(null))).resolves.toEqual({
      replayVerified: false,
      uniqueness: null,
      matchedBy: null,
      matchedValue: null,
      failureReason: "no primary locator",
      matchCount: null,
      visible: null,
      attempts: [],
    });
  });

  it("verifies candidates when the primary locator is absent", async () => {
    const fallback = {
      strategy: "playwright.testId" as const,
      value: 'page.getByTestId("save-button")',
      confidence: 0.86,
    };
    const page: ReplayPageLike = {
      getByTestId: (testId) => {
        expect(testId).toBe("save-button");
        return locator(1, true);
      },
    };

    await expect(verifyAttachmentLocator(page, createAttachment(null, [fallback]))).resolves.toEqual({
      replayVerified: true,
      uniqueness: true,
      matchedBy: "playwright.testId",
      matchedValue: 'page.getByTestId("save-button")',
      failureReason: null,
      matchCount: 1,
      visible: true,
      attempts: [
        {
          strategy: "playwright.testId",
          value: 'page.getByTestId("save-button")',
          replayVerified: true,
          uniqueness: true,
          failureReason: null,
          matchCount: 1,
          visible: true,
        },
      ],
    });
  });

  it("reports coordinates as unsupported for replay", async () => {
    const attachment = createAttachment({
      strategy: "coordinates",
      value: "10,20,80,32",
      confidence: 0.2,
    });

    await expect(verifyAttachmentLocator({}, attachment)).resolves.toMatchObject({
      replayVerified: false,
      uniqueness: null,
      matchedBy: null,
      matchedValue: null,
      failureReason: "coordinates locators cannot be replay verified",
    });
  });

  it("updates attachment stability without mutating the original attachment", () => {
    const attachment = createAttachment({
      strategy: "playwright.text",
      value: "page.getByText(\"Save\")",
      confidence: 0.74,
    });

    const updated = applyReplayResult(attachment, {
      replayVerified: true,
      uniqueness: true,
      matchedBy: "playwright.text",
      matchedValue: "page.getByText(\"Save\")",
      failureReason: null,
      matchCount: 1,
      visible: true,
      attempts: [
        {
          strategy: "playwright.text",
          value: "page.getByText(\"Save\")",
          replayVerified: true,
          uniqueness: true,
          failureReason: null,
          matchCount: 1,
          visible: true,
        },
      ],
    });

    expect(updated.locatorBundle.stability).toEqual({
      score: 78,
      uniqueness: true,
      replayVerified: true,
      verifiedBy: "playwright.text",
      verifiedValue: "page.getByText(\"Save\")",
      failureReason: null,
    });
    expect(attachment.locatorBundle.stability.replayVerified).toBe(false);
  });
});
